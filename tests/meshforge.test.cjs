'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const { parseGlbBuffer, inspectGlb, createSampleGlb } = require('../lib/glb.cjs');
const { generateFromPromptPureCode, compileSceneToGlb } = require('../lib/procedural-3d.cjs');
const { decodePng, encodePng, computeDistanceTransform, generateFromImagePureCode } = require('../lib/image-to-3d.cjs');
const { generateModel3D, listProviders, selectAutoProvider } = require('../lib/providers.cjs');
const { installClients, removeClients, checkClientsStatus, getClientTargets } = require('../lib/installers.cjs');
const { probeMcpServer, callMcpTool } = require('../lib/prober.cjs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meshforge-test-'));
}

function makeTestSubjectPng(width = 48, height = 48) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const dx = (x - width / 2) / (width * 0.3);
      const dy = (y - height / 2) / (height * 0.3);
      const inside = dx * dx + dy * dy <= 1.0;
      if (inside) {
        rgba[i] = 220;
        rgba[i + 1] = 128;
        rgba[i + 2] = 52;
        rgba[i + 3] = 255;
      } else {
        rgba[i] = 245;
        rgba[i + 1] = 245;
        rgba[i + 2] = 245;
        rgba[i + 3] = 255;
      }
    }
  }
  return encodePng(width, height, rgba);
}

test('GLB generator and parser validate binary chunks, vertices, triangles, and bounds', () => {
  const buf = createSampleGlb({ name: 'UnitTestPrism' });
  const parsed = parseGlbBuffer(buf);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.stats.meshes, 1);
  assert.equal(parsed.stats.vertices, 4);
  assert.equal(parsed.stats.triangles, 4);
  assert.equal(parsed.stats.materials, 1);
  assert.deepEqual(parsed.bounds.min.map((n) => Number(n.toFixed(2))), [-0.65, -0.45, -0.65]);
  assert.deepEqual(parsed.bounds.max.map((n) => Number(n.toFixed(2))), [0.65, 0.75, 0.55]);
});

test('parseGlbBuffer rejects invalid headers', () => {
  assert.throws(() => parseGlbBuffer(Buffer.from('not-a-glb-file-at-all')), /missing glTF magic/i);
});

test('pure-code PNG codec round-trips RGBA pixels and EDT computes exact silhouette distances', () => {
  const pngBuf = makeTestSubjectPng(32, 32);
  const decoded = decodePng(pngBuf);
  assert.equal(decoded.width, 32);
  assert.equal(decoded.height, 32);
  assert.equal(decoded.rgba[0], 245); // corner bg

  const mask = new Uint8Array(9);
  mask[4] = 1; // single center pixel
  const dt = computeDistanceTransform(mask, 3, 3);
  assert.equal(dt[4], 1);
  assert.equal(dt[0], 0);
});

test('pure-code Image-to-3D inflation and relief generate watertight UV-textured GLBs without API keys', () => {
  const tmp = makeTempDir();
  try {
    const imgPath = path.join(tmp, 'badge.png');
    fs.writeFileSync(imgPath, makeTestSubjectPng(48, 48));

    const inflated = generateFromImagePureCode(imgPath, { mode: 'inflate', gridMax: 32 });
    const parsedInflated = parseGlbBuffer(inflated.glb);
    assert.equal(parsedInflated.valid, true);
    assert.equal(parsedInflated.stats.textures, 1);
    assert.equal(parsedInflated.stats.images, 1);
    assert.ok(parsedInflated.stats.triangles > 200);

    const relief = generateFromImagePureCode(imgPath, { mode: 'relief', gridMax: 24 });
    const parsedRelief = parseGlbBuffer(relief.glb);
    assert.equal(parsedRelief.valid, true);
    assert.equal(parsedRelief.stats.textures, 1);
    assert.ok(parsedRelief.stats.triangles > 500);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('pure-code Text-to-3D archetypes and SDF Marching Tetrahedra compile into multi-part PBR GLBs', () => {
  const hp = generateFromPromptPureCode('copper studio headphones');
  const parsedHp = parseGlbBuffer(hp.glb);
  assert.equal(hp.archetype, 'headphone');
  assert.equal(parsedHp.valid, true);
  assert.equal(parsedHp.stats.meshes, 9);
  assert.ok(parsedHp.stats.triangles > 1000);

  const custom = compileSceneToGlb({
    parts: [
      {
        name: 'OrganicBlob',
        type: 'sdf',
        resolution: 18,
        sdf: {
          op: 'smoothUnion',
          k: 0.25,
          children: [
            { shape: 'sphere', radius: 0.5, position: [-0.25, 0, 0] },
            { shape: 'box', size: [0.6, 0.6, 0.6], round: 0.08, position: [0.3, 0, 0] }
          ]
        },
        material: { color: 'gold', metallic: 0.85, roughness: 0.2 }
      }
    ]
  });
  const parsedSdf = parseGlbBuffer(custom);
  assert.equal(parsedSdf.valid, true);
  assert.ok(parsedSdf.stats.triangles > 100);
});

test('generateModel3D auto mode defaults to pure-code offline and image-inflate with zero API keys', async () => {
  const tmp = makeTempDir();
  try {
    const textRes = await generateModel3D({
      prompt: 'minimalist ceramic coffee mug',
      outputDir: tmp,
      env: {}
    });
    assert.equal(textRes.ok, true);
    assert.equal(textRes.provider, 'pure-code');
    assert.ok(fs.existsSync(textRes.glbPath));
    assert.ok(fs.existsSync(textRes.previewPath));

    const imgPath = path.join(tmp, 'item.png');
    fs.writeFileSync(imgPath, makeTestSubjectPng(32, 32));
    const imgRes = await generateModel3D({
      imagePath: imgPath,
      outputDir: tmp,
      gridMax: 24,
      env: {}
    });
    assert.equal(imgRes.ok, true);
    assert.equal(imgRes.provider, 'image-inflate');
    assert.equal(imgRes.inspection.stats.textures, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Gradio mock server handles optional remote/local endpoint upload, SSE inference, and GLB download', async () => {
  const tmp = makeTempDir();
  const sampleGlb = createSampleGlb({ name: 'MockHunyuanMesh' });
  const imgPath = path.join(tmp, 'ref.png');
  fs.writeFileSync(imgPath, makeTestSubjectPng(16, 16));

  let sawUpload = false;
  let sawCaption = null;

  const server = http.createServer((req, res) => {
    if (req.url === '/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '4.44.0', api_prefix: '' }));
      return;
    }
    if (req.url === '/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ named_endpoints: { '/generation_all': { parameters: [] } } }));
      return;
    }
    if (req.url === '/upload' && req.method === 'POST') {
      sawUpload = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(['/tmp/gradio/abc/ref.png']));
      return;
    }
    if (req.url === '/call/generation_all' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        sawCaption = parsed.data[0];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ event_id: 'evt-123' }));
      });
      return;
    }
    if (req.url === '/call/generation_all/evt-123' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: complete\ndata: [{"path":"/tmp/out/model.glb"}]\n\n');
      res.end();
      return;
    }
    if (req.url === '/file=/tmp/out/model.glb') {
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary' });
      res.end(sampleGlb);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const out = await generateModel3D({
      prompt: 'retro copper kettle',
      imagePath: imgPath,
      provider: 'local-gradio',
      outputDir: path.join(tmp, 'out'),
      env: { MESHFORGE_LOCAL_URL: baseUrl }
    });
    assert.equal(sawUpload, true);
    assert.equal(sawCaption, 'retro copper kettle');
    assert.equal(out.ok, true);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('selectAutoProvider works zero-key by default', () => {
  assert.equal(selectAutoProvider({ prompt: 'chair', env: {} }), 'pure-code');
  assert.equal(selectAutoProvider({ image: 'logo.png', env: {} }), 'image-inflate');
  assert.equal(selectAutoProvider({ prompt: 'chair', env: { MESHFORGE_LOCAL_URL: 'http://127.0.0.1:7860' } }), 'local-gradio');
  assert.equal(listProviders({}).some((p) => p.id === 'pure-code' && p.configured === true && p.requiresKey === false), true);
});

test('atomic client installer handles Codex TOML, Gemini/Claude JSON, drift protection, and removal', () => {
  const tmp = makeTempDir();
  try {
    const home = tmp;
    const codexHome = path.join(tmp, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[mcp_servers.other]\ncommand = "echo"\nargs = ["hi"]\n');

    const targets = getClientTargets({ home, appdata: path.join(tmp, 'AppData'), platform: 'win32', codexHome });
    const stateFile = path.join(tmp, 'state.json');

    const installed = installClients({
      targets,
      clientIds: ['codex', 'claude-code', 'gemini'],
      stateFile,
      nodeCommand: 'node',
      mcpServerScript: path.resolve(__dirname, '..', 'bin', 'mcp-server.cjs')
    });
    assert.equal(installed.every((r) => r.installed === true), true);

    const status = checkClientsStatus({ targets });
    assert.equal(status.find((s) => s.id === 'codex').configured, true);
    assert.equal(status.find((s) => s.id === 'gemini').configured, true);
    assert.equal(status.find((s) => s.id === 'claude-code').configured, true);

    fs.appendFileSync(path.join(codexHome, 'config.toml'), '# manual edit\n');
    const blocked = removeClients({ targets, clientIds: ['codex'], stateFile });
    assert.equal(blocked[0].removed, false);

    const removed = removeClients({ targets, clientIds: ['codex', 'gemini', 'claude-code'], stateFile, force: true });
    assert.equal(removed.every((r) => r.removed === true), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('MCP stdio handshake lists 7 tools and executes mesh_generate_3d + mesh_build_scene purely offline', async () => {
  const probe = await probeMcpServer();
  assert.equal(probe.ok, true);
  assert.equal(probe.toolCount, 7);
  assert.ok(probe.tools.some((t) => t.name === 'mesh_build_scene'));

  const tmp = makeTempDir();
  try {
    const genCall = await callMcpTool({
      toolName: 'mesh_generate_3d',
      arguments: { prompt: 'gold rocket', outputDir: tmp }
    });
    assert.equal(genCall.ok, true);
    const parsedGen = JSON.parse(genCall.result.content[0].text);
    assert.equal(parsedGen.ok, true);
    assert.equal(parsedGen.provider, 'pure-code');
    assert.ok(fs.existsSync(parsedGen.glbPath));

    const sceneCall = await callMcpTool({
      toolName: 'mesh_build_scene',
      arguments: {
        name: 'custom-pillar',
        outputDir: tmp,
        parts: [
          { name: 'Base', type: 'cylinder', radius: 0.5, height: 0.2, material: { color: 'silver', metallic: 0.9, roughness: 0.2 } },
          { name: 'Orb', type: 'sphere', radius: 0.28, position: [0, 0.35, 0], material: { color: 'copper', metallic: 0.85, roughness: 0.25 } }
        ]
      }
    });
    assert.equal(sceneCall.ok, true);
    const parsedScene = JSON.parse(sceneCall.result.content[0].text);
    assert.equal(parsedScene.ok, true);
    assert.equal(parsedScene.inspection.stats.meshes, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
