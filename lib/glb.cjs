'use strict';

const fs = require('node:fs');
const path = require('node:path');

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

/**
 * Parses and validates a GLB (glTF 2.0 binary) buffer, returning mesh and material metrics.
 * @param {Buffer} buffer
 */
function parseGlbBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) {
    throw new Error('File is too small to be a valid GLB binary.');
  }

  const magic = buffer.readUInt32LE(0);
  const version = buffer.readUInt32LE(4);
  const declaredLength = buffer.readUInt32LE(8);
  if (magic !== GLB_MAGIC) {
    throw new Error('Invalid GLB header: missing glTF magic bytes.');
  }
  if (version !== 2) {
    throw new Error(`Unsupported glTF binary version: ${version}. Expected version 2.`);
  }
  if (declaredLength > buffer.length) {
    throw new Error(`Truncated GLB: header declares ${declaredLength} bytes, got ${buffer.length}.`);
  }

  let offset = 12;
  let gltf = null;
  let binLength = 0;
  let chunkCount = 0;

  while (offset + 8 <= declaredLength) {
    const chunkLen = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLen;
    if (dataEnd > declaredLength) {
      throw new Error('Malformed GLB chunk extends beyond declared file length.');
    }
    if (chunkType === CHUNK_JSON && !gltf) {
      const jsonText = buffer.toString('utf8', dataStart, dataEnd).replace(/\0+$/, '').trim();
      gltf = JSON.parse(jsonText);
    } else if (chunkType === CHUNK_BIN) {
      binLength += chunkLen;
    }
    chunkCount += 1;
    offset = dataEnd;
  }

  if (!gltf || typeof gltf !== 'object') {
    throw new Error('GLB does not contain a valid JSON chunk.');
  }

  const accessors = Array.isArray(gltf.accessors) ? gltf.accessors : [];
  const meshes = Array.isArray(gltf.meshes) ? gltf.meshes : [];
  const materials = Array.isArray(gltf.materials) ? gltf.materials : [];
  const textures = Array.isArray(gltf.textures) ? gltf.textures : [];
  const images = Array.isArray(gltf.images) ? gltf.images : [];
  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  const animations = Array.isArray(gltf.animations) ? gltf.animations : [];

  let vertices = 0;
  let triangles = 0;
  let primitiveCount = 0;
  let min = null;
  let max = null;

  for (const mesh of meshes) {
    const primitives = Array.isArray(mesh.primitives) ? mesh.primitives : [];
    for (const prim of primitives) {
      primitiveCount += 1;
      const attrs = prim.attributes || {};
      const posAcc = typeof attrs.POSITION === 'number' ? accessors[attrs.POSITION] : null;
      if (posAcc && typeof posAcc.count === 'number') {
        vertices += posAcc.count;
        if (Array.isArray(posAcc.min) && posAcc.min.length === 3) {
          min = min
            ? [Math.min(min[0], posAcc.min[0]), Math.min(min[1], posAcc.min[1]), Math.min(min[2], posAcc.min[2])]
            : [...posAcc.min];
        }
        if (Array.isArray(posAcc.max) && posAcc.max.length === 3) {
          max = max
            ? [Math.max(max[0], posAcc.max[0]), Math.max(max[1], posAcc.max[1]), Math.max(max[2], posAcc.max[2])]
            : [...posAcc.max];
        }
      }
      const mode = prim.mode === undefined ? 4 : prim.mode;
      if (mode === 4) {
        if (typeof prim.indices === 'number' && accessors[prim.indices]) {
          triangles += Math.floor((accessors[prim.indices].count || 0) / 3);
        } else if (posAcc && typeof posAcc.count === 'number') {
          triangles += Math.floor(posAcc.count / 3);
        }
      }
    }
  }

  const warnings = [];
  if (meshes.length === 0) warnings.push('No meshes found in glTF JSON.');
  if (vertices === 0) warnings.push('Total vertex count is 0.');
  if (!materials.length) warnings.push('No PBR materials defined (default material will be used).');
  if (!min || !max) warnings.push('POSITION accessor lacks min/max bounding box metadata.');

  return {
    valid: meshes.length > 0 && vertices > 0,
    format: 'glb',
    version,
    byteLength: buffer.length,
    declaredLength,
    chunkCount,
    binByteLength: binLength,
    generator: gltf.asset?.generator || null,
    stats: {
      meshes: meshes.length,
      primitives: primitiveCount,
      nodes: nodes.length,
      materials: materials.length,
      textures: textures.length,
      images: images.length,
      animations: animations.length,
      vertices,
      triangles
    },
    bounds: min && max ? { min, max } : null,
    warnings
  };
}

/**
 * Inspects a local GLB file on disk.
 * @param {string} filePath
 */
function inspectGlb(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`GLB file not found: ${resolved}`);
  }
  const buf = fs.readFileSync(resolved);
  return {
    filePath: resolved,
    ...parseGlbBuffer(buf)
  };
}

function pad4(buf, padByte = 0x00) {
  const rem = buf.length % 4;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(4 - rem, padByte)]);
}

/**
 * Computes smooth vertex normals for an indexed triangle mesh if not explicitly provided.
 * @param {Float32Array} positions
 * @param {Uint16Array|Uint32Array} indices
 * @returns {Float32Array}
 */
function computeVertexNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;

    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];

    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }

  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (len > 1e-8) {
      normals[i] /= len;
      normals[i + 1] /= len;
      normals[i + 2] /= len;
    } else {
      normals[i + 1] = 1;
    }
  }
  return normals;
}

function computePositionBounds(positions) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    min: [Number(minX.toFixed(6)), Number(minY.toFixed(6)), Number(minZ.toFixed(6))],
    max: [Number(maxX.toFixed(6)), Number(maxY.toFixed(6)), Number(maxZ.toFixed(6))]
  };
}

/**
 * Compiles one or more named mesh parts (positions, normals, uvs, indices, material, optional PNG texture)
 * into a spec-compliant glTF 2.0 binary (.glb) Buffer.
 */
function buildGlbFromParts({ parts = [], images = [], generator = 'meshforge-mcp' } = {}) {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('buildGlbFromParts requires at least one mesh part.');
  }

  const binChunks = [];
  let binCursor = 0;

  function pushBin(buf, target) {
    const aligned = pad4(buf, 0x00);
    const viewIndex = bufferViews.length;
    const bv = {
      buffer: 0,
      byteOffset: binCursor,
      byteLength: buf.length
    };
    if (target) bv.target = target;
    bufferViews.push(bv);
    binChunks.push(aligned);
    binCursor += aligned.length;
    return viewIndex;
  }

  const bufferViews = [];
  const accessors = [];
  const materials = [];
  const meshes = [];
  const nodes = [];
  const gltfImages = [];
  const gltfTextures = [];
  const samplers = [];

  if (images.length > 0) {
    samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 });
    for (const img of images) {
      const buf = Buffer.isBuffer(img.buffer) ? img.buffer : Buffer.from(img.buffer);
      const bvIdx = pushBin(buf);
      const imgIdx = gltfImages.length;
      gltfImages.push({ bufferView: bvIdx, mimeType: img.mimeType || 'image/png' });
      gltfTextures.push({ sampler: 0, source: imgIdx });
    }
  }

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const positions = part.positions instanceof Float32Array ? part.positions : new Float32Array(part.positions);
    const vertexCount = positions.length / 3;
    const needsUint32 = vertexCount > 65535;
    const indices = part.indices instanceof Uint32Array || part.indices instanceof Uint16Array
      ? part.indices
      : (needsUint32 ? new Uint32Array(part.indices) : new Uint16Array(part.indices));

    const normals = part.normals instanceof Float32Array
      ? part.normals
      : computeVertexNormals(positions, indices);

    const posBytes = Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength);
    const normBytes = Buffer.from(normals.buffer, normals.byteOffset, normals.byteLength);
    const idxBytes = Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength);

    const posView = pushBin(posBytes, 34962);
    const normView = pushBin(normBytes, 34962);

    const bounds = computePositionBounds(positions);
    const posAcc = accessors.length;
    accessors.push({
      bufferView: posView,
      componentType: 5126,
      count: vertexCount,
      type: 'VEC3',
      min: bounds.min,
      max: bounds.max
    });

    const normAcc = accessors.length;
    accessors.push({
      bufferView: normView,
      componentType: 5126,
      count: vertexCount,
      type: 'VEC3'
    });

    const attributes = { POSITION: posAcc, NORMAL: normAcc };

    if (part.uvs && part.uvs.length === vertexCount * 2) {
      const uvs = part.uvs instanceof Float32Array ? part.uvs : new Float32Array(part.uvs);
      const uvBytes = Buffer.from(uvs.buffer, uvs.byteOffset, uvs.byteLength);
      const uvView = pushBin(uvBytes, 34962);
      const uvAcc = accessors.length;
      accessors.push({
        bufferView: uvView,
        componentType: 5126,
        count: vertexCount,
        type: 'VEC2'
      });
      attributes.TEXCOORD_0 = uvAcc;
    }

    const idxView = pushBin(idxBytes, 34963);
    const idxAcc = accessors.length;
    accessors.push({
      bufferView: idxView,
      componentType: indices instanceof Uint32Array ? 5125 : 5123,
      count: indices.length,
      type: 'SCALAR'
    });

    const mat = part.material || {};
    const matIdx = materials.length;
    const pbr = {
      baseColorFactor: Array.isArray(mat.baseColorFactor) ? mat.baseColorFactor : [0.85, 0.56, 0.34, 1.0],
      metallicFactor: typeof mat.metallicFactor === 'number' ? mat.metallicFactor : 0.2,
      roughnessFactor: typeof mat.roughnessFactor === 'number' ? mat.roughnessFactor : 0.55
    };
    if (typeof mat.textureIndex === 'number' && gltfTextures[mat.textureIndex]) {
      pbr.baseColorTexture = { index: mat.textureIndex };
      pbr.baseColorFactor = [1, 1, 1, 1];
    }
    const matObj = {
      name: mat.name || `Material_${i}`,
      pbrMetallicRoughness: pbr
    };
    if (Array.isArray(mat.emissiveFactor)) matObj.emissiveFactor = mat.emissiveFactor;
    if (mat.doubleSided) matObj.doubleSided = true;
    materials.push(matObj);

    const meshIdx = meshes.length;
    meshes.push({
      name: part.name || `Mesh_${i}`,
      primitives: [{ attributes, indices: idxAcc, material: matIdx }]
    });

    const nodeObj = { mesh: meshIdx, name: part.name || `Node_${i}` };
    if (Array.isArray(part.translation)) nodeObj.translation = part.translation;
    if (Array.isArray(part.rotation)) nodeObj.rotation = part.rotation;
    if (Array.isArray(part.scale)) nodeObj.scale = part.scale;
    nodes.push(nodeObj);
  }

  const binChunk = Buffer.concat(binChunks);
  const gltf = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, idx) => idx) }],
    nodes,
    meshes,
    materials,
    ...(gltfTextures.length ? { textures: gltfTextures, images: gltfImages, samplers } : {}),
    buffers: [{ byteLength: binChunk.length }],
    bufferViews,
    accessors
  };

  const jsonChunk = pad4(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20);
  const totalLength = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const out = Buffer.alloc(totalLength);

  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLength, 8);

  let cursor = 12;
  out.writeUInt32LE(jsonChunk.length, cursor);
  out.writeUInt32LE(CHUNK_JSON, cursor + 4);
  jsonChunk.copy(out, cursor + 8);
  cursor += 8 + jsonChunk.length;

  out.writeUInt32LE(binChunk.length, cursor);
  out.writeUInt32LE(CHUNK_BIN, cursor + 4);
  binChunk.copy(out, cursor + 8);

  return out;
}

/**
 * Builds a minimal valid glTF 2.0 binary (.glb) tetrahedron for offline unit tests and smoke checks.
 * @param {{ name?: string }} [opts]
 * @returns {Buffer}
 */
function createSampleGlb({ name = 'MeshForge Demo Prism' } = {}) {
  return buildGlbFromParts({
    generator: 'meshforge-mcp-sample',
    parts: [
      {
        name,
        positions: new Float32Array([
          0, 0.75, 0,
          -0.65, -0.45, 0.55,
          0.65, -0.45, 0.55,
          0, -0.45, -0.65
        ]),
        indices: new Uint16Array([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]),
        material: {
          name: 'CopperAnodized',
          baseColorFactor: [0.85, 0.52, 0.28, 1.0],
          metallicFactor: 0.78,
          roughnessFactor: 0.28
        }
      }
    ]
  });
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Builds a self-contained Three.js studio viewer HTML for any local GLB file.
 * Uses prefixed CSS variables (--mf-*) and explicit high-contrast rules immune to host CSS overrides.
 */
function buildPreviewHtml({ glbPath, title = 'MeshForge 3D Preview', embedDataUri = true }) {
  const inspection = inspectGlb(glbPath);
  const safeTitle = escapeHtml(title);
  const fileName = escapeHtml(path.basename(inspection.filePath));
  const dataUri = embedDataUri
    ? `data:model/gltf-binary;base64,${fs.readFileSync(inspection.filePath).toString('base64')}`
    : `./${encodeURIComponent(path.basename(inspection.filePath))}`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${safeTitle}</title>
  <style>
    :root{color-scheme:only dark;--mf-bg:#121316;--mf-surface:#1b1d22;--mf-ink:#f5f4f0;--mf-muted:#c8c9d0;--mf-accent:#e0863a;--mf-accent-ink:#140e08;--mf-line:#343740}
    *{box-sizing:border-box}
    html,body{margin:0;height:100%;background:#121316;color:#f5f4f0;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
    .mf-shell{display:grid;grid-template-rows:auto 1fr auto;height:100%}
    .mf-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;border-bottom:1px solid var(--mf-line);background:var(--mf-surface)}
    .mf-title{font-weight:700;font-size:14px;color:#f5f4f0}
    .mf-meta{font:12px ui-monospace,monospace;color:#c8c9d0}
    .mf-stage{position:relative;width:100%;height:100%;min-height:420px;background:radial-gradient(circle at 50% 42%,#282420 0%,#16171b 55%,#101114 100%)}
    #mf-canvas{width:100%;height:100%;display:block;touch-action:none}
    .mf-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:12px 18px;border-top:1px solid var(--mf-line);background:var(--mf-surface)}
    .mf-btn{min-height:38px;padding:0 14px;border-radius:999px;border:1px solid var(--mf-line);background:#23262d;color:#f5f4f0;font-size:12px;font-weight:600;cursor:pointer}
    .mf-btn[aria-pressed="true"]{background:var(--mf-accent);border-color:var(--mf-accent);color:var(--mf-accent-ink)}
    .mf-err{position:absolute;inset:0;display:none;place-items:center;padding:24px;text-align:center;color:#f5f4f0}
  </style>
  <script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"}}</script>
</head>
<body>
  <div class="mf-shell">
    <header class="mf-bar">
      <div class="mf-title">${safeTitle} · <span class="mf-meta">${fileName}</span></div>
      <div class="mf-meta">${inspection.stats.vertices.toLocaleString('en-US')} vertices · ${inspection.stats.triangles.toLocaleString('en-US')} triangles · ${(inspection.byteLength / 1024).toFixed(1)} KB</div>
    </header>
    <main class="mf-stage">
      <canvas id="mf-canvas"></canvas>
      <div class="mf-err" id="mf-err"></div>
    </main>
    <footer class="mf-controls">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="mf-btn" id="mf-spin" type="button" aria-pressed="true">Auto-rotate</button>
        <button class="mf-btn" id="mf-wire" type="button" aria-pressed="false">Wireframe</button>
        <button class="mf-btn" id="mf-reset" type="button">Reset camera</button>
      </div>
      <span class="mf-meta">Drag to orbit · Scroll/pinch to zoom · Generated by meshforge-mcp</span>
    </footer>
  </div>
  <script type="module">
    const MODEL_SRC = ${JSON.stringify(dataUri)};
    const errEl = document.getElementById('mf-err');
    try {
      const THREE = await import('three');
      const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');

      const canvas = document.getElementById('mf-canvas');
      const host = canvas.parentElement;
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(host.clientWidth, host.clientHeight);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;

      const scene = new THREE.Scene();
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.add(new THREE.HemisphereLight(0xf6efe6, 0x1b1d22, 1.3));
      const key = new THREE.DirectionalLight(0xfff1e0, 2.8);
      key.position.set(3, 5, 4);
      scene.add(key);

      const camera = new THREE.PerspectiveCamera(36, host.clientWidth / host.clientHeight, 0.05, 200);
      const controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      controls.autoRotateSpeed = 1.0;

      const loaded = await new Promise((resolve, reject) => {
        new GLTFLoader().load(MODEL_SRC, resolve, undefined, reject);
      });
      const root = loaded.scene;
      const box = new THREE.Box3().setFromObject(root);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.001);
      root.position.sub(center);
      root.scale.setScalar(2.4 / maxDim);
      scene.add(root);

      const resetCam = () => {
        camera.position.set(2.4, 1.8, 3.6);
        controls.target.set(0, 0, 0);
        controls.update();
      };
      resetCam();

      const spinBtn = document.getElementById('mf-spin');
      spinBtn.setAttribute('aria-pressed', String(controls.autoRotate));
      spinBtn.addEventListener('click', () => {
        controls.autoRotate = !controls.autoRotate;
        spinBtn.setAttribute('aria-pressed', String(controls.autoRotate));
      });
      const wireBtn = document.getElementById('mf-wire');
      wireBtn.addEventListener('click', () => {
        const next = wireBtn.getAttribute('aria-pressed') !== 'true';
        wireBtn.setAttribute('aria-pressed', String(next));
        root.traverse((obj) => {
          if (obj.isMesh && obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach((m) => { m.wireframe = next; });
          }
        });
      });
      document.getElementById('mf-reset').addEventListener('click', resetCam);

      new ResizeObserver(() => {
        if (!host.clientWidth || !host.clientHeight) return;
        renderer.setSize(host.clientWidth, host.clientHeight);
        camera.aspect = host.clientWidth / host.clientHeight;
        camera.updateProjectionMatrix();
      }).observe(host);

      (function animate() {
        requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
      })();
    } catch (err) {
      errEl.style.display = 'grid';
      errEl.textContent = '3D preview failed to initialize: ' + (err && err.message ? err.message : String(err));
    }
  </script>
</body>
</html>`;

  return { html, inspection };
}

module.exports = {
  parseGlbBuffer,
  inspectGlb,
  computeVertexNormals,
  buildGlbFromParts,
  createSampleGlb,
  buildPreviewHtml
};
