'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const SERVER_NAME = 'meshforge-mcp';
const SKILL_NAME = 'meshforge-3d';
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

function hashEntry(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value === undefined ? null : value))
    .digest('hex');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function atomicWriteText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function readTextSafe(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const st = fs.lstatSync(filePath);
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_CONFIG_BYTES) {
    throw new Error(`Unsafe or oversized config file: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function getClientTargets({
  home = os.homedir(),
  appdata = process.env.APPDATA || path.join(home, '.config'),
  platform = process.platform,
  codexHome = process.env.CODEX_HOME || path.join(home, '.codex')
} = {}) {
  const claudeDesktop =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(appdata, 'Claude', 'claude_desktop_config.json');

  return [
    {
      id: 'codex',
      name: 'Codex',
      format: 'toml',
      configPath: path.join(codexHome, 'config.toml'),
      skillDirs: [path.join(home, '.agents', 'skills', SKILL_NAME), path.join(codexHome, 'skills', SKILL_NAME)]
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      format: 'json',
      configPath: path.join(home, '.claude.json'),
      skillDirs: [path.join(home, '.claude', 'skills', SKILL_NAME)]
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      format: 'json',
      configPath: claudeDesktop,
      skillDirs: []
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      format: 'json',
      configPath: path.join(home, '.gemini', 'settings.json'),
      skillDirs: [path.join(home, '.gemini', 'skills', SKILL_NAME)]
    },
    {
      id: 'cursor',
      name: 'Cursor',
      format: 'json',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      skillDirs: []
    },
    {
      id: 'antigravity',
      name: 'Antigravity',
      format: 'json',
      configPath: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
      skillDirs: []
    }
  ];
}

function tomlSections(text, serverName) {
  const safe = escapeRegExp(serverName);
  const ownedRe = new RegExp(`^mcp_servers\\.(?:${safe}|"${safe}"|'${safe}')(?:\\.|$)`);
  const lines = text.split(/(?<=\n)/);
  const ranges = [];
  let start = -1;
  let offset = 0;

  for (const line of lines) {
    const header = line.trim().match(/^\[([^\]]+)\]/);
    if (header) {
      const owned = ownedRe.test(header[1]);
      if (start >= 0 && !owned) {
        ranges.push([start, offset]);
        start = -1;
      }
      if (owned && start < 0) start = offset;
    }
    offset += line.length;
  }
  if (start >= 0) ranges.push([start, text.length]);
  return ranges;
}

function getTomlSection(text, serverName) {
  return tomlSections(text, serverName)
    .map(([s, e]) => text.slice(s, e))
    .join('');
}

function formatTomlServerSection(serverName, def) {
  const key = /^[A-Za-z0-9_-]+$/.test(serverName) ? serverName : JSON.stringify(serverName);
  const lines = [
    `[mcp_servers.${key}]`,
    `command = ${JSON.stringify(def.command)}`,
    `args = ${JSON.stringify(def.args || [])}`
  ];
  if (def.env && Object.keys(def.env).length > 0) {
    lines.push('', `[mcp_servers.${key}.env]`);
    for (const [k, v] of Object.entries(def.env)) {
      lines.push(`${k} = ${JSON.stringify(String(v))}`);
    }
  }
  return lines.join('\n') + '\n';
}

function upsertTomlMcpServer(text, serverName, def) {
  const section = formatTomlServerSection(serverName, def);
  let out = text;
  for (const [s, e] of tomlSections(text, serverName).reverse()) {
    out = out.slice(0, s) + out.slice(e);
  }
  const base = out.trimEnd();
  return base ? `${base}\n\n${section}` : section;
}

function removeTomlMcpServer(text, serverName) {
  let out = text;
  for (const [s, e] of tomlSections(text, serverName).reverse()) {
    out = out.slice(0, s) + out.slice(e);
  }
  return out.replace(/\n{3,}/g, '\n\n').trim() ? out.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n' : '';
}

function upsertJsonMcpServer(text, serverName, def) {
  const parsed = text.trim() ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Config JSON root must be an object.');
  }
  parsed.mcpServers = parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
  parsed.mcpServers[serverName] = def;
  return JSON.stringify(parsed, null, 2) + '\n';
}

function removeJsonMcpServer(text, serverName) {
  if (!text.trim()) return '';
  const parsed = JSON.parse(text);
  if (parsed?.mcpServers && Object.prototype.hasOwnProperty.call(parsed.mcpServers, serverName)) {
    delete parsed.mcpServers[serverName];
  }
  return JSON.stringify(parsed, null, 2) + '\n';
}

function defaultStateFile(home = os.homedir()) {
  return path.join(home, '.meshforge-mcp', 'installer-state.json');
}

function readState(stateFile) {
  try {
    if (!fs.existsSync(stateFile)) return {};
    return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {};
  } catch {
    return {};
  }
}

function copyDirRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDirRecursive(src, dest);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}

function installClients({
  serverName = SERVER_NAME,
  nodeCommand = process.execPath,
  mcpServerScript = path.resolve(__dirname, '..', 'bin', 'mcp-server.cjs'),
  env = null,
  skillSourceDir = path.resolve(__dirname, '..', 'skill'),
  targets = getClientTargets(),
  clientIds = null,
  stateFile = defaultStateFile(),
  dryRun = false,
  force = false
} = {}) {
  const selected = Array.isArray(clientIds) && clientIds.length
    ? targets.filter((t) => clientIds.includes(t.id))
    : targets;

  const def = {
    command: nodeCommand,
    args: [path.resolve(mcpServerScript)],
    ...(env && Object.keys(env).length ? { env } : {})
  };

  const state = readState(stateFile);
  const results = [];

  for (const target of selected) {
    const entry = { id: target.id, name: target.name, configPath: target.configPath, dryRun };
    try {
      const existing = readTextSafe(target.configPath);
      const currentEntry =
        target.format === 'toml'
          ? getTomlSection(existing, serverName)
          : (existing.trim() ? JSON.parse(existing)?.mcpServers?.[serverName] : null);
      const recorded = state[target.configPath];

      if (!force && currentEntry && recorded && recorded.hash !== hashEntry(currentEntry)) {
        throw new Error(`Manual edit detected in ${target.configPath}; pass --force to overwrite.`);
      }

      const next =
        target.format === 'toml'
          ? upsertTomlMcpServer(existing, serverName, def)
          : upsertJsonMcpServer(existing, serverName, def);

      const newEntry =
        target.format === 'toml'
          ? getTomlSection(next, serverName)
          : JSON.parse(next).mcpServers[serverName];

      if (!dryRun) {
        atomicWriteText(target.configPath, next);
        state[target.configPath] = { hash: hashEntry(newEntry), updatedAt: new Date().toISOString() };
      }
      entry.installed = true;
    } catch (err) {
      entry.installed = false;
      entry.error = err.message;
    }

    if (!dryRun && skillSourceDir && fs.existsSync(skillSourceDir) && target.skillDirs?.length) {
      entry.skillsInstalled = [];
      for (const dir of target.skillDirs) {
        try {
          copyDirRecursive(skillSourceDir, dir);
          entry.skillsInstalled.push(dir);
        } catch {}
      }
    }

    results.push(entry);
  }

  if (!dryRun) {
    atomicWriteText(stateFile, JSON.stringify(state, null, 2) + '\n');
  }
  return results;
}

function removeClients({
  serverName = SERVER_NAME,
  targets = getClientTargets(),
  clientIds = null,
  stateFile = defaultStateFile(),
  force = false
} = {}) {
  const selected = Array.isArray(clientIds) && clientIds.length
    ? targets.filter((t) => clientIds.includes(t.id))
    : targets;

  const state = readState(stateFile);
  const results = [];

  for (const target of selected) {
    const entry = { id: target.id, name: target.name, configPath: target.configPath };
    try {
      if (!fs.existsSync(target.configPath)) {
        entry.removed = false;
        entry.reason = 'Config file does not exist';
        results.push(entry);
        continue;
      }
      const existing = readTextSafe(target.configPath);
      const currentEntry =
        target.format === 'toml'
          ? getTomlSection(existing, serverName)
          : (existing.trim() ? JSON.parse(existing)?.mcpServers?.[serverName] : null);
      if (!currentEntry) {
        entry.removed = false;
        entry.reason = 'Server entry not present';
        results.push(entry);
        continue;
      }
      const recorded = state[target.configPath];
      if (!force && recorded && recorded.hash !== hashEntry(currentEntry)) {
        throw new Error(`Manual edit detected in ${target.configPath}; pass --force to remove.`);
      }
      const next =
        target.format === 'toml'
          ? removeTomlMcpServer(existing, serverName)
          : removeJsonMcpServer(existing, serverName);
      atomicWriteText(target.configPath, next);
      delete state[target.configPath];
      entry.removed = true;
    } catch (err) {
      entry.removed = false;
      entry.error = err.message;
    }
    results.push(entry);
  }

  atomicWriteText(stateFile, JSON.stringify(state, null, 2) + '\n');
  return results;
}

function checkClientsStatus({ serverName = SERVER_NAME, targets = getClientTargets() } = {}) {
  return targets.map((t) => {
    const configExists = fs.existsSync(t.configPath);
    let configured = false;
    if (configExists) {
      try {
        const raw = readTextSafe(t.configPath);
        if (t.format === 'toml') configured = Boolean(getTomlSection(raw, serverName));
        else configured = Boolean(raw.trim() && JSON.parse(raw)?.mcpServers?.[serverName]);
      } catch {}
    }
    const skillInstalled = (t.skillDirs || []).some((d) => fs.existsSync(path.join(d, 'SKILL.md')));
    return {
      id: t.id,
      name: t.name,
      configPath: t.configPath,
      configExists,
      configured,
      skillInstalled
    };
  });
}

module.exports = {
  SERVER_NAME,
  SKILL_NAME,
  getClientTargets,
  upsertTomlMcpServer,
  removeTomlMcpServer,
  upsertJsonMcpServer,
  removeJsonMcpServer,
  installClients,
  removeClients,
  checkClientsStatus
};
