#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inspectGlb, buildPreviewHtml } = require('../lib/glb.cjs');
const { listProviders, generateModel3D } = require('../lib/providers.cjs');
const { installClients, removeClients, checkClientsStatus } = require('../lib/installers.cjs');
const { inspectGradioApp } = require('../lib/gradio-client.cjs');

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals[0] || 'help', positionals: positionals.slice(1), flags };
}

function printHelp() {
  console.log(`meshforge — Zero-API-key, pure-code Text/Image-to-3D CLI & MCP server

Usage:
  meshforge generate [--prompt "..."] [--image ./photo.png] [--provider auto|pure-code|image-inflate|image-relief] [--out ./out]
  meshforge build-scene <scene.json> [--out ./out]
  meshforge inspect <file.glb>
  meshforge preview <file.glb> [--out ./preview.html]
  meshforge providers
  meshforge install [--clients codex,claude-code,gemini,claude-desktop,cursor,antigravity] [--dry-run] [--force]
  meshforge remove [--clients ...] [--force]
  meshforge status
  meshforge doctor

Examples:
  meshforge generate --prompt "copper studio headphones" --out ./out
  meshforge generate --image ./logo.png --provider image-inflate --out ./out
  meshforge generate --image ./portrait.png --provider image-relief --out ./out
  meshforge install --clients codex,claude-code,gemini
`);
}

async function main() {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));
  const clientIds = typeof flags.clients === 'string'
    ? flags.clients.split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    case 'providers':
      console.log(JSON.stringify(listProviders(), null, 2));
      return;
    case 'generate': {
      const res = await generateModel3D({
        prompt: typeof flags.prompt === 'string' ? flags.prompt : positionals[0] || '',
        imagePath: typeof flags.image === 'string' ? flags.image : '',
        imageUrl: typeof flags['image-url'] === 'string' ? flags['image-url'] : '',
        provider: typeof flags.provider === 'string' ? flags.provider : 'auto',
        outputDir: typeof flags.out === 'string' ? flags.out : './meshforge-out',
        name: typeof flags.name === 'string' ? flags.name : '',
        gridMax: flags['grid-max'] ? Number(flags['grid-max']) : 76,
        depthScale: flags['depth-scale'] ? Number(flags['depth-scale']) : 0.28,
        invert: Boolean(flags.invert),
        writePreview: flags['no-preview'] ? false : true
      });
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    case 'build-scene': {
      const file = positionals[0] || flags.file;
      if (!file) throw new Error('Usage: meshforge build-scene <scene.json> [--out ./out]');
      const scene = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
      const res = await generateModel3D({
        name: scene.name || path.basename(file, '.json'),
        scene,
        provider: 'pure-code',
        outputDir: typeof flags.out === 'string' ? flags.out : './meshforge-out',
        writePreview: flags['no-preview'] ? false : true
      });
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    case 'inspect': {
      const file = positionals[0] || flags.file;
      if (!file) throw new Error('Usage: meshforge inspect <file.glb>');
      console.log(JSON.stringify(inspectGlb(file), null, 2));
      return;
    }
    case 'preview': {
      const file = positionals[0] || flags.file;
      if (!file) throw new Error('Usage: meshforge preview <file.glb> [--out ./preview.html]');
      const outPath = path.resolve(typeof flags.out === 'string' ? flags.out : file.replace(/\.glb$/i, '-preview.html'));
      const { html, inspection } = buildPreviewHtml({ glbPath: file, title: path.basename(file) });
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, html, 'utf8');
      console.log(JSON.stringify({ ok: true, previewPath: outPath, inspection }, null, 2));
      return;
    }
    case 'install':
      console.log(JSON.stringify(installClients({
        clientIds,
        dryRun: Boolean(flags['dry-run']),
        force: Boolean(flags.force)
      }), null, 2));
      return;
    case 'remove':
      console.log(JSON.stringify(removeClients({
        clientIds,
        force: Boolean(flags.force)
      }), null, 2));
      return;
    case 'status':
      console.log(JSON.stringify(checkClientsStatus(), null, 2));
      return;
    case 'doctor': {
      const providers = listProviders();
      const clients = checkClientsStatus();
      const endpoints = { 'pure-code': { reachable: true, offline: true } };
      for (const [k, u] of [
        ['hunyuan3d-hf', process.env.MESHFORGE_HUNYUAN_URL || 'https://tencent-hunyuan3d-2.hf.space'],
        ['sf3d-hf', process.env.MESHFORGE_SF3D_URL || 'https://stabilityai-stable-fast-3d.hf.space']
      ]) {
        try {
          const info = await inspectGradioApp(u, { token: process.env.HF_TOKEN || '', timeoutMs: 6000 });
          endpoints[k] = { reachable: Boolean(info.info), apiPrefix: info.apiPrefix || '/' };
        } catch (err) {
          endpoints[k] = { reachable: false, error: err.message };
        }
      }
      console.log(JSON.stringify({ nodeVersion: process.version, providers, endpoints, clients }, null, 2));
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}. Run "meshforge help".`);
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
