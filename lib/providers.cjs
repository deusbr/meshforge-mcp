'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectGlb, createSampleGlb, buildPreviewHtml } = require('./glb.cjs');
const { generateFromPromptPureCode, compileSceneToGlb } = require('./procedural-3d.cjs');
const { generateFromImagePureCode } = require('./image-to-3d.cjs');
const {
  inspectGradioApp,
  uploadGradioFile,
  callGradioEndpoint,
  resolveGradioOutputUrl
} = require('./gradio-client.cjs');

const DEFAULT_HUNYUAN_URL = 'https://tencent-hunyuan3d-2.hf.space';
const DEFAULT_SF3D_URL = 'https://stabilityai-stable-fast-3d.hf.space';

const PROVIDERS = {
  'pure-code': {
    id: 'pure-code',
    name: 'Pure-Code Local Engine (SDF + Procedural + 2D->3D Inflation)',
    kind: 'local-pure-code',
    modes: ['text', 'image', 'scene-dsl'],
    requiresKey: false,
    optionalEnv: [],
    description: '100% offline, zero API key, zero GPU. Uses parametric geometry, SDF Marching Tetrahedra, EDT silhouette inflation, and luminance relief heightmaps.'
  },
  'image-inflate': {
    id: 'image-inflate',
    name: 'Pure-Code Image Inflation (Teddy / EDT Silhouette -> 3D GLB)',
    kind: 'local-pure-code',
    modes: ['image'],
    requiresKey: false,
    optionalEnv: [],
    description: 'Segments foreground from PNG/BMP/image, computes 2D Euclidean Distance Transform, and inflates a watertight UV-textured 3D GLB locally.'
  },
  'image-relief': {
    id: 'image-relief',
    name: 'Pure-Code Heightmap / Relief Slab (Luminance -> 3D GLB)',
    kind: 'local-pure-code',
    modes: ['image'],
    requiresKey: false,
    optionalEnv: [],
    description: 'Converts image luminance into a Gaussian-smoothed watertight 3D relief/lithophane GLB with embedded UV texture.'
  },
  'hunyuan3d-hf': {
    id: 'hunyuan3d-hf',
    name: 'Hunyuan3D-2 (Optional Free Hugging Face Space)',
    kind: 'free-cloud',
    modes: ['text', 'image', 'multiview'],
    requiresKey: false,
    optionalEnv: ['HF_TOKEN', 'MESHFORGE_HUNYUAN_URL'],
    description: 'Optional ZeroGPU cloud inference via tencent/Hunyuan3D-2 Gradio Space (no API key required, subject to HF queue).'
  },
  'sf3d-hf': {
    id: 'sf3d-hf',
    name: 'Stable Fast 3D (Optional Free Hugging Face Space)',
    kind: 'free-cloud',
    modes: ['image'],
    requiresKey: false,
    optionalEnv: ['HF_TOKEN', 'MESHFORGE_SF3D_URL'],
    description: 'Optional ZeroGPU single-image-to-GLB via stabilityai/stable-fast-3d Gradio Space.'
  },
  'local-gradio': {
    id: 'local-gradio',
    name: 'Local GPU Gradio Server (Hunyuan3D / TRELLIS / SF3D)',
    kind: 'local',
    modes: ['text', 'image', 'multiview'],
    requiresKey: false,
    optionalEnv: ['MESHFORGE_LOCAL_URL'],
    description: 'Connects to a self-hosted local Gradio 4/5 3D server (default http://127.0.0.1:7860).'
  },
  demo: {
    id: 'demo',
    name: 'Offline Minimal Sample GLB (Smoke Test Only)',
    kind: 'offline',
    modes: ['text', 'image'],
    requiresKey: false,
    description: 'Generates a minimal 4-vertex prism GLB for fast pipeline verification.'
  }
};

function isConfigured(provider, env = process.env) {
  if (provider.id === 'local-gradio') return Boolean(env.MESHFORGE_LOCAL_URL);
  return true;
}

function listProviders(env = process.env) {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    modes: p.modes,
    requiresKey: p.requiresKey,
    requiredEnv: [],
    optionalEnv: p.optionalEnv || [],
    configured: isConfigured(p, env),
    description: p.description
  }));
}

function slugify(text, fallback = 'model') {
  const clean = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return clean || fallback;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function downloadFile(url, destPath, { headers = {}, timeoutMs = 120000 } = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`Failed to download generated asset (${res.status}) from ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  ensureDir(path.dirname(destPath));
  fs.writeFileSync(destPath, buf);
  return destPath;
}

async function resolveImagePathLocal(imageInput, tmpDir) {
  if (!imageInput) return { localPath: '', cleanup: () => {} };
  if (/^https?:\/\//i.test(imageInput)) {
    const res = await fetch(imageInput, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Failed to fetch input image URL (${res.status}): ${imageInput}`);
    const ext = imageInput.toLowerCase().includes('.jpg') || imageInput.toLowerCase().includes('.jpeg') ? '.jpg' : '.png';
    const tmpFile = path.join(tmpDir, `input-${Date.now()}${ext}`);
    ensureDir(tmpDir);
    fs.writeFileSync(tmpFile, Buffer.from(await res.arrayBuffer()));
    return { localPath: tmpFile, cleanup: () => { try { fs.unlinkSync(tmpFile); } catch {} } };
  }
  return { localPath: path.resolve(imageInput), cleanup: () => {} };
}

async function resolveImageForGradio(imageInput, baseUrl, apiPrefix, token, tmpDir) {
  if (!imageInput) return null;
  const { localPath, cleanup } = await resolveImagePathLocal(imageInput, tmpDir);
  try {
    return await uploadGradioFile(baseUrl, apiPrefix, localPath, { token });
  } finally {
    cleanup();
  }
}

async function runHunyuanGradio({
  baseUrl,
  prompt,
  image,
  multiview = {},
  texture = true,
  steps = 30,
  guidanceScale = 5.5,
  octreeResolution = 256,
  removeBackground = true,
  seed = 1234,
  token = '',
  outputPath,
  timeoutMs = 240000
}) {
  const preflight = await inspectGradioApp(baseUrl, { token });
  const tmpDir = path.dirname(outputPath);

  const mainImage = image ? await resolveImageForGradio(image, preflight.baseUrl, preflight.apiPrefix, token, tmpDir) : null;
  const front = multiview.front ? await resolveImageForGradio(multiview.front, preflight.baseUrl, preflight.apiPrefix, token, tmpDir) : null;
  const back = multiview.back ? await resolveImageForGradio(multiview.back, preflight.baseUrl, preflight.apiPrefix, token, tmpDir) : null;
  const left = multiview.left ? await resolveImageForGradio(multiview.left, preflight.baseUrl, preflight.apiPrefix, token, tmpDir) : null;
  const right = multiview.right ? await resolveImageForGradio(multiview.right, preflight.baseUrl, preflight.apiPrefix, token, tmpDir) : null;

  const apiName = texture ? 'generation_all' : 'shape_generation';
  const payload = [
    prompt || null,
    mainImage,
    front,
    back,
    left,
    right,
    Number(steps) || 30,
    Number(guidanceScale) || 5.5,
    Number(seed) || 1234,
    Number(octreeResolution) || 256,
    Boolean(removeBackground),
    8000,
    seed === undefined || seed === null
  ];

  const result = await callGradioEndpoint({
    baseUrl: preflight.baseUrl,
    apiName,
    data: payload,
    token,
    timeoutMs,
    preflight
  });

  const glbUrl = resolveGradioOutputUrl(result.data, preflight.baseUrl, preflight.apiPrefix, ['.glb', '.gltf', '.obj', '.ply']);
  if (!glbUrl) {
    throw new Error(`Hunyuan3D endpoint /${apiName} did not return a downloadable 3D mesh URL.`);
  }
  await downloadFile(glbUrl, outputPath, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { remoteUrl: glbUrl, endpoint: apiName };
}

async function runSf3dGradio({
  baseUrl,
  image,
  foregroundRatio = 0.85,
  remeshOption = 'None',
  vertexCount = -1,
  textureSize = 1024,
  token = '',
  outputPath,
  timeoutMs = 180000
}) {
  if (!image) {
    throw new Error('Stable Fast 3D requires an input image (imagePath or imageUrl).');
  }
  const preflight = await inspectGradioApp(baseUrl, { token });
  const uploaded = await resolveImageForGradio(image, preflight.baseUrl, preflight.apiPrefix, token, path.dirname(outputPath));
  const result = await callGradioEndpoint({
    baseUrl: preflight.baseUrl,
    apiName: 'run_button',
    data: [uploaded, Number(foregroundRatio) || 0.85, remeshOption, Number(vertexCount), Number(textureSize) || 1024],
    token,
    timeoutMs,
    preflight
  });
  const glbUrl = resolveGradioOutputUrl(result.data, preflight.baseUrl, preflight.apiPrefix, ['.glb', '.gltf']);
  if (!glbUrl) {
    throw new Error('Stable Fast 3D endpoint did not return a GLB asset URL.');
  }
  await downloadFile(glbUrl, outputPath, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { remoteUrl: glbUrl, endpoint: 'run_button' };
}

function selectAutoProvider({ image, scene, env = process.env } = {}) {
  if (scene && Array.isArray(scene.parts)) return 'pure-code';
  if (env.MESHFORGE_LOCAL_URL) return 'local-gradio';
  if (image) return 'image-inflate';
  return 'pure-code';
}

/**
 * Generates a GLB 3D model from text, image, or declarative Scene DSL.
 * Defaults to 100% pure-code offline execution with zero API keys required.
 */
async function generateModel3D({
  prompt = '',
  imagePath = '',
  imageUrl = '',
  scene = null,
  multiview = {},
  provider = 'auto',
  outputDir = path.join(process.cwd(), 'meshforge-out'),
  name = '',
  texture = true,
  steps = 30,
  guidanceScale = 5.5,
  octreeResolution = 256,
  seed = 1234,
  gridMax = 76,
  depthScale = 0.28,
  invert = false,
  writePreview = true,
  env = process.env,
  timeoutMs = 240000
} = {}) {
  const image = imagePath || imageUrl || '';
  const hasMultiview = Boolean(multiview && (multiview.front || multiview.back || multiview.left || multiview.right));
  if (!prompt && !image && !scene && !hasMultiview && provider !== 'demo') {
    throw new Error('Provide at least one input: prompt, imagePath, imageUrl, or scene.');
  }

  const chosenProvider = provider === 'auto' ? selectAutoProvider({ image, prompt, scene, env }) : provider;
  if (!PROVIDERS[chosenProvider]) {
    throw new Error(`Unknown provider "${chosenProvider}". Supported: ${Object.keys(PROVIDERS).join(', ')}`);
  }

  const resolvedOutDir = path.resolve(outputDir);
  ensureDir(resolvedOutDir);
  const baseSlug = slugify(name || prompt || (image ? path.basename(image, path.extname(image)) : 'mesh'), 'mesh');
  const shortHash = crypto.createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 6);
  const glbPath = path.join(resolvedOutDir, `${baseSlug}-${shortHash}.glb`);

  let meta = {};
  const startedAt = Date.now();

  if (chosenProvider === 'demo') {
    fs.writeFileSync(glbPath, createSampleGlb({ name: name || prompt || 'Demo Mesh' }));
    meta = { mode: 'offline-sample' };
  } else if (chosenProvider === 'pure-code') {
    if (scene && Array.isArray(scene.parts)) {
      fs.writeFileSync(glbPath, compileSceneToGlb(scene));
      meta = { technique: 'declarative-scene-dsl', parts: scene.parts.length };
    } else if (image && !prompt) {
      const { localPath, cleanup } = await resolveImagePathLocal(image, resolvedOutDir);
      try {
        const res = generateFromImagePureCode(localPath, { mode: 'inflate', gridMax, depthScale, invert });
        fs.writeFileSync(glbPath, res.glb);
        meta = { technique: res.technique, sourceSize: res.sourceSize };
      } finally {
        cleanup();
      }
    } else {
      const res = generateFromPromptPureCode(prompt, { scene });
      fs.writeFileSync(glbPath, res.glb);
      meta = { technique: 'procedural-sdf-archetype', archetype: res.archetype };
    }
  } else if (chosenProvider === 'image-inflate' || chosenProvider === 'image-relief') {
    if (!image) throw new Error(`Provider "${chosenProvider}" requires imagePath or imageUrl.`);
    const { localPath, cleanup } = await resolveImagePathLocal(image, resolvedOutDir);
    try {
      const mode = chosenProvider === 'image-relief' ? 'relief' : 'inflate';
      const res = generateFromImagePureCode(localPath, { mode, gridMax, depthScale, invert });
      fs.writeFileSync(glbPath, res.glb);
      meta = { technique: res.technique, sourceSize: res.sourceSize };
    } finally {
      cleanup();
    }
  } else if (chosenProvider === 'hunyuan3d-hf') {
    meta = await runHunyuanGradio({
      baseUrl: env.MESHFORGE_HUNYUAN_URL || DEFAULT_HUNYUAN_URL,
      prompt,
      image,
      multiview,
      texture,
      steps,
      guidanceScale,
      octreeResolution,
      seed,
      token: env.HF_TOKEN || '',
      outputPath: glbPath,
      timeoutMs
    });
  } else if (chosenProvider === 'sf3d-hf') {
    meta = await runSf3dGradio({
      baseUrl: env.MESHFORGE_SF3D_URL || DEFAULT_SF3D_URL,
      image,
      token: env.HF_TOKEN || '',
      outputPath: glbPath,
      timeoutMs
    });
  } else if (chosenProvider === 'local-gradio') {
    const localUrl = env.MESHFORGE_LOCAL_URL || 'http://127.0.0.1:7860';
    meta = await runHunyuanGradio({
      baseUrl: localUrl,
      prompt,
      image,
      multiview,
      texture,
      steps,
      guidanceScale,
      octreeResolution,
      seed,
      outputPath: glbPath,
      timeoutMs
    });
  }

  const inspection = inspectGlb(glbPath);
  let previewPath = null;
  if (writePreview) {
    previewPath = path.join(resolvedOutDir, `${baseSlug}-${shortHash}-preview.html`);
    const { html } = buildPreviewHtml({ glbPath, title: name || prompt || path.basename(glbPath) });
    fs.writeFileSync(previewPath, html, 'utf8');
  }

  return {
    ok: inspection.valid,
    provider: chosenProvider,
    elapsedMs: Date.now() - startedAt,
    glbPath,
    previewPath,
    inspection,
    meta
  };
}

module.exports = {
  PROVIDERS,
  listProviders,
  generateModel3D,
  selectAutoProvider
};
