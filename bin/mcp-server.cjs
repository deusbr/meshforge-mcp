#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { inspectGlb, buildPreviewHtml } = require('../lib/glb.cjs');
const { listProviders, generateModel3D } = require('../lib/providers.cjs');
const { installClients, checkClientsStatus } = require('../lib/installers.cjs');
const { inspectGradioApp } = require('../lib/gradio-client.cjs');

const TOOLS = [
  {
    name: 'mesh_list_providers',
    description: 'List 3D generation engines. Default pure-code engines (pure-code, image-inflate, image-relief) run 100% offline with zero API keys; optional free Hugging Face Spaces and local Gradio GPU endpoints are also available.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'mesh_generate_3d',
    description: 'Generate a validated PBR .glb 3D model from text or image purely in local code (default, zero API key) or optional Gradio backends, plus an interactive Three.js preview HTML.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text prompt describing the 3D object.' },
        imagePath: { type: 'string', description: 'Local path to an input PNG/BMP/JPEG image.' },
        imageUrl: { type: 'string', description: 'Public HTTPS URL of an input image.' },
        provider: {
          type: 'string',
          enum: ['auto', 'pure-code', 'image-inflate', 'image-relief', 'hunyuan3d-hf', 'sf3d-hf', 'local-gradio', 'demo'],
          description: 'Engine to use (default "auto" -> pure-code / image-inflate offline, zero API key).'
        },
        outputDir: { type: 'string', description: 'Directory to save the generated .glb and preview .html.' },
        name: { type: 'string', description: 'Optional output file slug/title.' },
        gridMax: { type: 'integer', description: 'Mesh grid resolution for pure-code image-to-3D (default 76).' },
        depthScale: { type: 'number', description: '3D inflation/relief depth factor for image-to-3D (default 0.28).' },
        invert: { type: 'boolean', description: 'Invert luminance heightmap in image-relief mode.' },
        writePreview: { type: 'boolean', description: 'Write an interactive Three.js HTML preview beside the GLB (default true).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'mesh_build_scene',
    description: 'Compile a custom declarative 3D Scene DSL (box, sphere, cylinder, cone, torus, lathe, tube, extrude, and smooth-boolean SDF Marching Tetrahedra + PBR materials) purely in code into a validated .glb with zero API keys.',
    inputSchema: {
      type: 'object',
      required: ['parts'],
      properties: {
        name: { type: 'string', description: 'Model name/slug.' },
        outputDir: { type: 'string', description: 'Directory to save the .glb and preview .html.' },
        writePreview: { type: 'boolean', description: 'Write Three.js preview HTML (default true).' },
        parts: {
          type: 'array',
          description: 'Array of 3D parts ({ name, type: box|sphere|cylinder|cone|torus|lathe|tube|extrude|sdf, position, rotation, scale, material, ... }).',
          items: { type: 'object' }
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'mesh_inspect_glb',
    description: 'Inspect and validate a local .glb (glTF 2.0 binary) file, returning vertex/triangle counts, bounding box, materials, textures, and validation warnings.',
    inputSchema: {
      type: 'object',
      required: ['glbPath'],
      properties: {
        glbPath: { type: 'string', description: 'Absolute or relative path to the .glb file.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'mesh_preview_html',
    description: 'Generate a self-contained Three.js interactive 3D studio HTML preview for a local .glb file.',
    inputSchema: {
      type: 'object',
      required: ['glbPath'],
      properties: {
        glbPath: { type: 'string', description: 'Path to the .glb file.' },
        outputPath: { type: 'string', description: 'Optional destination HTML path.' },
        title: { type: 'string', description: 'Viewer page title.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'mesh_install_clients',
    description: 'Install or check meshforge-mcp configuration across Codex, Claude Code, Claude Desktop, Gemini CLI, Cursor, and Antigravity.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'install'], description: 'Default "status".' },
        clients: {
          type: 'array',
          items: { type: 'string', enum: ['codex', 'claude-code', 'claude-desktop', 'gemini', 'cursor', 'antigravity'] }
        },
        dryRun: { type: 'boolean', description: 'Preview config updates without writing files.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'mesh_doctor',
    description: 'Verify local pure-code capabilities, optional Gradio endpoints, and MCP client registrations.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handleToolCall(name, args = {}) {
  switch (name) {
    case 'mesh_list_providers':
      return { providers: listProviders() };
    case 'mesh_generate_3d':
      return generateModel3D(args);
    case 'mesh_build_scene':
      return generateModel3D({
        name: args.name || 'custom-scene',
        outputDir: args.outputDir,
        writePreview: args.writePreview !== false,
        provider: 'pure-code',
        scene: { parts: args.parts }
      });
    case 'mesh_inspect_glb':
      return inspectGlb(args.glbPath);
    case 'mesh_preview_html': {
      const { html, inspection } = buildPreviewHtml({ glbPath: args.glbPath, title: args.title || path.basename(args.glbPath) });
      const outPath = path.resolve(args.outputPath || args.glbPath.replace(/\.glb$/i, '-preview.html'));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, html, 'utf8');
      return { ok: true, previewPath: outPath, inspection };
    }
    case 'mesh_install_clients': {
      if (args.action === 'install') {
        return {
          results: installClients({
            clientIds: args.clients || null,
            dryRun: Boolean(args.dryRun)
          })
        };
      }
      return { clients: checkClientsStatus() };
    }
    case 'mesh_doctor': {
      const providers = listProviders();
      const clients = checkClientsStatus();
      const endpoints = { 'pure-code': { reachable: true, offline: true } };
      for (const [key, url] of [
        ['hunyuan3d-hf', process.env.MESHFORGE_HUNYUAN_URL || 'https://tencent-hunyuan3d-2.hf.space'],
        ['sf3d-hf', process.env.MESHFORGE_SF3D_URL || 'https://stabilityai-stable-fast-3d.hf.space'],
        ...(process.env.MESHFORGE_LOCAL_URL ? [['local-gradio', process.env.MESHFORGE_LOCAL_URL]] : [])
      ]) {
        try {
          const info = await inspectGradioApp(url, { token: process.env.HF_TOKEN || '', timeoutMs: 6000 });
          endpoints[key] = { reachable: Boolean(info.info), apiPrefix: info.apiPrefix || '/' };
        } catch (err) {
          endpoints[key] = { reachable: false, error: err.message };
        }
      }
      return { ok: true, nodeVersion: process.version, providers, endpoints, clients };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    respondError(null, -32700, 'Parse error');
    return;
  }

  const { id, method, params } = req;
  if (method === 'notifications/initialized' || id === undefined) return;

  try {
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'meshforge-mcp', version: '0.2.0' }
      });
      return;
    }
    if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
      return;
    }
    if (method === 'tools/call') {
      const result = await handleToolCall(params?.name, params?.arguments || {});
      respond(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: false
      });
      return;
    }
    if (method === 'ping') {
      respond(id, {});
      return;
    }
    respondError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    if (method === 'tools/call') {
      respond(id, {
        content: [{ type: 'text', text: err.message || String(err) }],
        isError: true
      });
    } else {
      respondError(id, -32000, err.message || String(err));
    }
  }
});
