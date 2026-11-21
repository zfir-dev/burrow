// Log helpers for the dashboard: tails, downloads and a combined stream of every
// project's cloudflared log (~/.local/state/burrow/<project>.log).
import { existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { stateDir } from '../config.js';
import { logFile } from '../process.js';

const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/;

export function readRange(file, from, to) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(to - from);
    readSync(fd, buf, 0, buf.length, from);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

// The last `bytes` of a file, starting at a line boundary.
export function readTail(file, bytes) {
  if (!existsSync(file)) return '';
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  let text = readRange(file, start, size);
  if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  return text;
}

// Projects with a log file in the state dir.
export function logProjects(dir = stateDir()) {
  try {
    return readdirSync(dir).filter((f) => /^[a-z0-9-]+\.log$/.test(f)).map((f) => f.slice(0, -4)).sort();
  } catch {
    return [];
  }
}

// Interleave lines from several logs by their leading timestamp (lines without one
// stay right after the line before them).
export function mergeByTime(perProject) {
  const out = [];
  for (const [project, lines] of perProject) {
    let last = 0;
    lines.forEach((line, i) => {
      const m = line.match(TS);
      if (m) last = Date.parse(m[1]) || last;
      out.push({ project, line, t: last, i });
    });
  }
  return out.sort((a, b) => a.t - b.t || (a.project === b.project ? a.i - b.i : a.project.localeCompare(b.project)));
}

const lines = (text) => text.split('\n').map((l) => l.replace(/\r/g, '')).filter((l) => l.length);

export function combinedText(projects = logProjects(), bytesEach = 2 * 1024 * 1024) {
  const merged = mergeByTime(projects.map((p) => [p, lines(readTail(logFile(p), bytesEach))]));
  return merged.map((e) => `[${e.project}] ${e.line}`).join('\n') + (merged.length ? '\n' : '');
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
export const downloadName = (what) => `burrow-${what}-${stamp()}.log`;

// SSE: `data: {"p": project, "l": line}` for every project's log, backlog first.
export function streamAll(req, res, headers, { backlogBytes = 16 * 1024, intervalMs = 1000 } = {}) {
  res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (project, line) => res.write(`data: ${JSON.stringify({ p: project, l: line })}\n\n`);
  const files = new Map(); // project -> { pos, partial }
  const backlog = [];
  for (const p of logProjects()) {
    const file = logFile(p);
    backlog.push([p, lines(readTail(file, backlogBytes))]);
    files.set(p, { pos: statSync(file).size, partial: '' });
  }
  for (const e of mergeByTime(backlog)) send(e.project, e.line);
  if (!files.size) res.write(`data: ${JSON.stringify({ p: '', l: '(no logs yet)' })}\n\n`);
  const poll = setInterval(() => {
    for (const p of logProjects()) {
      try {
        const file = logFile(p);
        const st = files.get(p) || { pos: 0, partial: '' };
        files.set(p, st);
        const size = statSync(file).size;
        if (size < st.pos) { st.pos = 0; st.partial = ''; send(p, '(log truncated)'); }
        if (size > st.pos) {
          const to = Math.min(size, st.pos + 256 * 1024);
          const parts = (st.partial + readRange(file, st.pos, to)).split('\n');
          st.partial = parts.pop();
          st.pos = to;
          for (const l of parts) send(p, l.replace(/\r/g, ''));
        }
      } catch {}
    }
  }, intervalMs);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(poll); clearInterval(ping); });
}
