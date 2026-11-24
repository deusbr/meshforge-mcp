'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

function runStdioSession({ command = process.execPath, args = [], requests = [], timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const responses = new Map();
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`MCP stdio timeout after ${timeoutMs}ms${stderrBuf ? ': ' + stderrBuf.trim() : ''}`));
    }, timeoutMs);

    const expectedIds = requests.filter((r) => r.id !== undefined).map((r) => r.id);

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) responses.set(msg.id, msg);
        } catch {}
      }
      if (!settled && expectedIds.every((id) => responses.has(id))) {
        settled = true;
        clearTimeout(timer);
        child.stdin.end();
        child.kill();
        resolve({ responses, latencyMs: Date.now() - start, stderr: stderrBuf.trim() });
      }
    });

    child.stderr.on('data', (d) => { stderrBuf += d.toString('utf8'); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (expectedIds.every((id) => responses.has(id))) {
        resolve({ responses, latencyMs: Date.now() - start, stderr: stderrBuf.trim() });
      } else {
        reject(new Error(`MCP server exited (${code}) before answering all requests.${stderrBuf ? ' ' + stderrBuf.trim() : ''}`));
      }
    });

    for (const req of requests) {
      child.stdin.write(JSON.stringify(req) + '\n');
    }
  });
}

async function probeMcpServer({ serverPath = path.resolve(__dirname, '..', 'bin', 'mcp-server.cjs'), command = process.execPath, timeoutMs = 10000 } = {}) {
  const { responses, latencyMs, stderr } = await runStdioSession({
    command,
    args: [path.resolve(serverPath)],
    timeoutMs,
    requests: [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'meshforge-prober', version: '1.0.0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
    ]
  });

  const initRes = responses.get(1);
  const listRes = responses.get(2);
  if (initRes?.error) throw new Error(initRes.error.message);
  if (listRes?.error) throw new Error(listRes.error.message);

  const tools = listRes?.result?.tools || [];
  const schemaBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  return {
    ok: true,
    serverInfo: initRes?.result?.serverInfo || null,
    protocolVersion: initRes?.result?.protocolVersion || null,
    toolCount: tools.length,
    estimatedSchemaTokens: Math.ceil(schemaBytes / 4),
    latencyMs,
    stderr,
    tools
  };
}

async function callMcpTool({ serverPath = path.resolve(__dirname, '..', 'bin', 'mcp-server.cjs'), command = process.execPath, toolName, arguments: toolArgs = {}, timeoutMs = 15000 } = {}) {
  const { responses, latencyMs } = await runStdioSession({
    command,
    args: [path.resolve(serverPath)],
    timeoutMs,
    requests: [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'meshforge-prober', version: '1.0.0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: toolArgs } }
    ]
  });
  const callRes = responses.get(2);
  if (callRes?.error) return { ok: false, latencyMs, error: callRes.error.message };
  return { ok: !callRes?.result?.isError, latencyMs, result: callRes?.result || null };
}

module.exports = {
  probeMcpServer,
  callMcpTool
};
