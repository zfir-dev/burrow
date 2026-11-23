// After a project is renamed (see the dashboard's Rename…), its local files follow it:
// the cloudflared log, the background pre_up log, and its `burrow watch` state entry.
// The event history and hook results keep the old name: they describe the past.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logFile } from './process.js';
import { backgroundLogFile } from './hooks.js';
import { watchStateFile } from './watch.js';

// Move one file. When the target already exists (a log left by an earlier project with the
// new name), the old file is appended to it, so no line is lost. Returns true when moved.
function moveFile(from, to) {
  if (!existsSync(from)) return false;
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  if (existsSync(to)) {
    appendFileSync(to, readFileSync(from));
    rmSync(from, { force: true });
  } else renameSync(from, to);
  return true;
}

export function moveProjectState(from, to) {
  if (!from || !to || from === to) return [];
  const moved = [];
  for (const [a, b] of [[logFile(from), logFile(to)], [backgroundLogFile(from), backgroundLogFile(to)]]) {
    if (moveFile(a, b)) moved.push(b);
  }
  try {
    const file = watchStateFile();
    const st = JSON.parse(readFileSync(file, 'utf8'));
    if (st && typeof st === 'object' && st[from]) {
      st[to] = st[from];
      delete st[from];
      writeFileSync(file, JSON.stringify(st, null, 2) + '\n', { mode: 0o600 });
      moved.push(file);
    }
  } catch {}
  return moved;
}
