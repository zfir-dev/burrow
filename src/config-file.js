// Update KEY=value lines in the burrow config file, keeping comments, order and mode 600.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configPath } from './config.js';

const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

// updates: { KEY: 'value' | '' (clear) }. Values are single-line and unquoted.
export function setConfigValues(updates, path = configPath()) {
  for (const [k, v] of Object.entries(updates)) {
    if (!KEY_RE.test(k)) throw new Error(`bad config key ${k}`);
    if (typeof v !== 'string' || /[\r\n\0]/.test(v)) throw new Error(`${k}: value must be a single line`);
  }
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const done = new Set();
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && m[1] in updates) {
      if (done.has(m[1])) continue; // drop duplicates, the first one wins in parseEnv
      out.push(`${m[1]}=${updates[m[1]]}`);
      done.add(m[1]);
    } else out.push(line);
  }
  for (const [k, v] of Object.entries(updates)) if (!done.has(k)) out.push(`${k}=${v}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, out.join('\n') + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
