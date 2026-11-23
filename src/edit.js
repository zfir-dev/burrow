import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import YAML from 'yaml';
import { assertLabel } from './naming.js';
import { parseHooks } from './hooks.js';
import { findProjectFile, parseProject } from './project.js';
import { readMeta, runningPid } from './process.js';

const log = (...a) => console.log(...a);

export function findOnPath(bin, path = process.env.PATH || '') {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try { accessSync(join(dir, bin), constants.X_OK); return join(dir, bin); } catch {}
  }
  return null;
}

// $VISUAL, then $EDITOR (may carry arguments, e.g. "code --wait"), then vi, then nano.
export function pickEditor(env = process.env) {
  for (const v of [env.VISUAL, env.EDITOR]) if (v && v.trim()) return v.trim();
  for (const bin of ['vi', 'nano']) if (findOnPath(bin, env.PATH)) return bin;
  return null;
}

// -f, ./tunnel.yml (when it is this project's), or the file remembered by `burrow up`.
// The file is not validated here, so a broken tunnel.yml can still be opened and fixed.
export function resolveEditFile(projectArg, opts = {}) {
  if (projectArg) assertLabel(projectArg, 'project name');
  let file = findProjectFile(opts.file);
  if (file && projectArg) {
    let name = null;
    try { name = parseProject(readFileSync(file, 'utf8'), file).project; } catch {}
    if (name && name !== projectArg) {
      if (opts.file) throw new Error(`${file} is for project "${name}", not "${projectArg}".`);
      file = null;
    }
  }
  if (!file && projectArg) {
    const meta = readMeta(projectArg);
    if (meta?.file && existsSync(meta.file)) file = meta.file;
  }
  if (!file) {
    throw new Error(
      `No tunnel.yml found${opts.file ? ` at ${opts.file}` : ' in the current directory'}` +
        (projectArg ? ` and no remembered file for "${projectArg}"` : '') + '. Use -f <path>.'
    );
  }
  return file;
}

// y/N question. Returns null when stdin is not a terminal.
async function ask(question, defaultYes) {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim();
    return a ? /^y(es)?$/i.test(a) : defaultYes;
  } finally { rl.close(); }
}

function runEditor(editor, file) {
  // Through sh so EDITOR may contain arguments; the file name is passed as $1, never interpolated.
  const r = spawnSync('/bin/sh', ['-c', `${editor} "$1"`, 'sh', file], { stdio: 'inherit' });
  if (r.error) throw new Error(`Could not start editor "${editor}": ${r.error.message}`);
  return r.status;
}

export async function edit(projectArg, opts = {}) {
  const file = resolveEditFile(projectArg, opts);
  const editor = pickEditor();
  if (!editor) throw new Error('No editor found. Set $EDITOR (for example: export EDITOR=nano).');
  const original = readFileSync(file, 'utf8');
  let before = null;
  try { before = parseProject(original, file); } catch {}

  // Edit a private copy; tunnel.yml is only replaced once the new text is valid.
  const dir = mkdtempSync(join(tmpdir(), 'burrow-edit-'));
  const tmp = join(dir, basename(file));
  writeFileSync(tmp, original, { mode: 0o600 });
  let text;
  let proj;
  for (;;) {
    const status = runEditor(editor, tmp);
    if (status !== 0) {
      console.error(`Editor exited with ${status === null ? 'a signal' : `code ${status}`}; ${file} is unchanged. Your edits are in ${tmp}`);
      process.exitCode = 1;
      return;
    }
    text = readFileSync(tmp, 'utf8');
    if (text === original) {
      rmSync(dir, { recursive: true, force: true });
      log(`No changes to ${file}.`);
      return;
    }
    try {
      proj = parseProject(text, file);
      // hooks: is read by up/down, not by parseProject; check it here so a typo in a hook
      // name or option is caught on save instead of on the next start.
      parseHooks(YAML.parse(text) || {}, file);
      break;
    } catch (e) {
      console.error(`burrow: ${e.message}`);
      if (!(await ask('Re-open the editor to fix it?', true))) {
        console.error(`Not saved: ${file} is unchanged. Your edits are in ${tmp}`);
        process.exitCode = 1;
        return;
      }
    }
  }
  writeFileSync(file, text);
  rmSync(dir, { recursive: true, force: true });
  log(`Saved ${file} (project ${proj.project}, ${proj.services.length} service(s)).`);
  if (before && before.project !== proj.project) {
    log(`Note: the project was renamed from ${before.project} to ${proj.project}. ` +
      `Tunnel burrow-${before.project} is kept; remove it with "burrow destroy ${before.project}".`);
  }

  const pid = runningPid(proj.project);
  const later = `burrow up -f ${file}`;
  if (!pid) { log(`${proj.project} is not running. Start it with: ${later}`); return; }
  if (opts.apply === false) { log(`Not applied (--no-apply). Apply it with: ${later}`); return; }
  let go = !!opts.yes;
  if (!go) {
    const answer = await ask(`${proj.project} is running (pid ${pid}). Apply the change now (burrow up)?`, true);
    if (answer === null) { log(`${proj.project} is running, but this is not a terminal. Pass --yes to apply, or run: ${later}`); return; }
    go = answer;
  }
  if (!go) { log(`Not applied. Apply it later with: ${later}`); return; }
  const cmd = await import('./commands.js');
  await cmd.up(undefined, { file, dryRun: opts.dryRun });
}
