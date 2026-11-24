'use strict';

const fs = require('node:fs');
const path = require('node:path');

function buildAuthHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.glb') return 'model/gltf-binary';
  return 'application/octet-stream';
}

/**
 * Discovers Gradio config/apiPrefix (empty for Gradio 4.x, '/gradio_api' for Gradio 5.x)
 * and named endpoints when exposed.
 * @param {string} baseUrl
 * @param {{ token?: string, timeoutMs?: number }} [opts]
 */
async function inspectGradioApp(baseUrl, { token = '', timeoutMs = 15000 } = {}) {
  const cleanBase = String(baseUrl || '').replace(/\/+$/, '');
  const headers = buildAuthHeaders(token);
  let apiPrefix = '';

  try {
    const cfgRes = await fetch(`${cleanBase}/config`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      if (typeof cfg.api_prefix === 'string') {
        apiPrefix = cfg.api_prefix.replace(/\/+$/, '');
      }
    }
  } catch {}

  const candidates = apiPrefix ? [apiPrefix, ''] : ['', '/gradio_api'];
  for (const prefix of candidates) {
    try {
      const infoRes = await fetch(`${cleanBase}${prefix}/info`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (infoRes.ok) {
        const info = await infoRes.json();
        return { baseUrl: cleanBase, apiPrefix: prefix, info };
      }
    } catch {}
  }

  return { baseUrl: cleanBase, apiPrefix, info: null };
}

/**
 * Uploads a local file to a Gradio 4/5 server and returns a Gradio FileData object.
 * @param {string} baseUrl
 * @param {string} apiPrefix
 * @param {string} filePath
 * @param {{ token?: string, timeoutMs?: number }} [opts]
 */
async function uploadGradioFile(baseUrl, apiPrefix, filePath, { token = '', timeoutMs = 60000 } = {}) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Input image not found: ${resolved}`);
  }
  const bytes = fs.readFileSync(resolved);
  const blob = new Blob([bytes], { type: guessMimeType(resolved) });
  const form = new FormData();
  form.append('files', blob, path.basename(resolved));

  const res = await fetch(`${baseUrl}${apiPrefix}/upload`, {
    method: 'POST',
    headers: buildAuthHeaders(token),
    body: form,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    throw new Error(`Gradio file upload failed (${res.status}): ${await res.text()}`);
  }
  const uploaded = await res.json();
  const remotePath = Array.isArray(uploaded) ? uploaded[0] : null;
  if (!remotePath) {
    throw new Error('Gradio upload succeeded without returning a remote file path.');
  }
  return {
    path: remotePath,
    orig_name: path.basename(resolved),
    meta: { _type: 'gradio_file' }
  };
}

/**
 * Parses Gradio SSE text stream and returns the payload of the 'complete' event.
 * @param {Response} response
 */
async function readGradioSse(response) {
  if (!response.body) {
    throw new Error('Empty SSE stream from Gradio endpoint.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let currentEvent = 'message';
  let dataLines = [];

  function flushBlock() {
    if (!dataLines.length) {
      currentEvent = 'message';
      return null;
    }
    const rawData = dataLines.join('\n');
    const evt = currentEvent;
    currentEvent = 'message';
    dataLines = [];
    if (evt === 'complete') {
      return { done: true, data: JSON.parse(rawData) };
    }
    if (evt === 'error') {
      let msg = rawData;
      try {
        const parsed = JSON.parse(rawData);
        msg = parsed?.message || parsed?.error || rawData;
      } catch {}
      throw new Error(`Gradio inference failed: ${msg}`);
    }
    return null;
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line === '') {
        const res = flushBlock();
        if (res?.done) return res.data;
        continue;
      }
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
  }

  if (buffer.trim()) {
    if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trim());
  }
  const trailing = flushBlock();
  if (trailing?.done) return trailing.data;
  throw new Error('Gradio SSE stream ended before a complete event arrived.');
}

/**
 * Calls a named Gradio endpoint over REST + SSE (supports both Gradio 4 and Gradio 5).
 */
async function callGradioEndpoint({
  baseUrl,
  apiName,
  data,
  token = '',
  timeoutMs = 240000,
  preflight
} = {}) {
  const cleanEndpoint = String(apiName || '').replace(/^\/+/, '');
  const meta = preflight || (await inspectGradioApp(baseUrl, { token, timeoutMs: 15000 }));
  const headers = {
    'Content-Type': 'application/json',
    ...buildAuthHeaders(token)
  };

  const postRes = await fetch(`${meta.baseUrl}${meta.apiPrefix}/call/${cleanEndpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(Math.min(timeoutMs, 30000))
  });
  if (!postRes.ok) {
    throw new Error(`Gradio POST /call/${cleanEndpoint} failed (${postRes.status}): ${await postRes.text()}`);
  }
  const queued = await postRes.json();
  if (!queued?.event_id) {
    throw new Error(`Gradio /call/${cleanEndpoint} did not return an event_id.`);
  }

  const sseRes = await fetch(`${meta.baseUrl}${meta.apiPrefix}/call/${cleanEndpoint}/${queued.event_id}`, {
    headers: buildAuthHeaders(token),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!sseRes.ok) {
    throw new Error(`Gradio SSE /call/${cleanEndpoint}/${queued.event_id} failed (${sseRes.status}).`);
  }
  return {
    baseUrl: meta.baseUrl,
    apiPrefix: meta.apiPrefix,
    data: await readGradioSse(sseRes)
  };
}

/**
 * Extracts the first matching file URL or path from a Gradio output array.
 * @param {unknown[]} outputs
 * @param {string} baseUrl
 * @param {string} apiPrefix
 * @param {string[]} [preferredExts]
 */
function resolveGradioOutputUrl(outputs, baseUrl, apiPrefix = '', preferredExts = ['.glb', '.gltf', '.obj', '.ply']) {
  const candidates = [];
  function walk(node) {
    if (!node) return;
    if (typeof node === 'string') {
      candidates.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      if (typeof node.url === 'string') candidates.push(node.url);
      if (typeof node.path === 'string') candidates.push(node.path);
      if (node.value) walk(node.value);
    }
  }
  walk(outputs);

  const normalized = candidates
    .map((item) => {
      if (/^https?:\/\//i.test(item)) return item;
      if (item.startsWith('/file=') || item.startsWith('/gradio_api/file=')) return `${baseUrl}${item}`;
      return `${baseUrl}${apiPrefix}/file=${item}`;
    });

  for (const ext of preferredExts) {
    const match = normalized.find((u) => u.toLowerCase().includes(ext));
    if (match) return match;
  }
  return normalized[0] || null;
}

module.exports = {
  inspectGradioApp,
  uploadGradioFile,
  callGradioEndpoint,
  resolveGradioOutputUrl
};
