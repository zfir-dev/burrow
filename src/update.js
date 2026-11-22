import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const log = (...a) => console.log(...a);
export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GIT_TIMEOUT = 60_000;
const PULL_TIMEOUT = 180_000;
const NPM_TIMEOUT = 600_000;
const gitBin = () => process.env.BURROW_GIT || 'git';
const npmBin = () => process.env.BURROW_NPM || 'npm';

// Every child gets a timeout, and git never waits for a password prompt.
function run(bin, args, { cwd, timeout = GIT_TIMEOUT, inherit = false } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  const r = spawnSync(bin, args, {
    cwd, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL', stdio: inherit ? ['ignore', 'inherit', 'inherit'] : 'pipe',
  });
  if (r.error?.code === 'ETIMEDOUT') throw new Error(`${bin} ${args.join(' ')} timed out after ${timeout / 1000}s`);
  if (r.error) throw new Error(`Could not run ${bin}: ${r.error.message}`);
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}
function must(bin, args, opts) {
  const r = run(bin, args, opts);
  if (!r.ok) throw new Error(`${bin} ${args.join(' ')} failed: ${r.err || r.out || `exit ${r.status}`}`);
  return r.out;
}
const git = (cwd, ...args) => must(gitBin(), args, { cwd });
const short = (sha) => String(sha || '').slice(0, 7);
const readPkg = (root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// How is this copy installed?
//   git:     a git checkout (git pull --ff-only + npm install)
//   npm:     <prefix>/lib/node_modules/burrow from `npm install -g` (reinstall with npm)
//   unknown: anything else
export function detectInstall(root = PACKAGE_ROOT) {
  root = resolve(root);
  const pkg = readPkg(root);
  if (existsSync(join(root, '.git'))) {
    const top = run(gitBin(), ['rev-parse', '--show-toplevel'], { cwd: root });
    if (top.ok && realpathSync(top.out) === realpathSync(root)) return { mode: 'git', root, pkg };
  }
  const nm = dirname(root);
  if (basename(nm) === 'node_modules') {
    const prefix = basename(dirname(nm)) === 'lib' ? dirname(dirname(nm)) : dirname(nm);
    let resolved = null;
    try {
      const lock = JSON.parse(readFileSync(join(nm, '.package-lock.json'), 'utf8'));
      resolved = lock.packages?.[`node_modules/${pkg.name}`]?.resolved || null;
    } catch {}
    return { mode: 'npm', root, pkg, prefix, resolved };
  }
  return { mode: 'unknown', root, pkg };
}

// A git URL for `git ls-remote`, plus an optional ref, from an npm-style spec:
// github:owner/repo, owner/repo, git+ssh://…, git+https://…, file:///…, /a/path, with an optional #ref.
export function gitUrl(spec) {
  let s = String(spec || '').trim();
  let ref = null;
  const hash = s.indexOf('#');
  if (hash >= 0) { ref = s.slice(hash + 1) || null; s = s.slice(0, hash); }
  let m;
  if ((m = s.match(/^github:([\w.-]+\/[\w.-]+?)(?:\.git)?$/)) || (m = s.match(/^([\w.-]+\/[\w.-]+?)(?:\.git)?$/))) {
    return { url: `https://github.com/${m[1]}.git`, ref };
  }
  if (s.startsWith('git+')) s = s.slice(4);
  return { url: s, ref };
}

const isGitSpec = (s) => /^(git\+|github:|git@|git:\/\/)/.test(String(s || ''));
const isSha = (s) => /^[0-9a-f]{7,40}$/.test(String(s || ''));

// Where updates come from: BURROW_UPDATE_SOURCE, else the git URL npm recorded at install
// time, else "repository" in package.json.
export function updateSource(info, env = process.env) {
  let spec = env.BURROW_UPDATE_SOURCE || '';
  let installed = null;
  if (info.resolved && isGitSpec(info.resolved)) {
    const { url, ref } = gitUrl(info.resolved);
    if (isSha(ref)) installed = ref;
    if (!spec) spec = info.resolved.startsWith('git+') ? `git+${url}` : url;
  }
  if (!spec) {
    const repo = info.pkg.repository;
    spec = typeof repo === 'string' ? repo : repo?.url || '';
  }
  if (!spec) throw new Error('No update source: set BURROW_UPDATE_SOURCE (e.g. github:<owner>/burrow).');
  const { url, ref } = gitUrl(spec);
  return { spec, url, ref: isSha(ref) ? null : ref, installed };
}

export function checkGit(info) {
  const cwd = info.root;
  const branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  const up = run(gitBin(), ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd });
  if (!up.ok) throw new Error(`Branch ${branch} in ${cwd} has no upstream. Set one with: git branch -u origin/${branch}`);
  git(cwd, 'fetch', '--quiet');
  const head = git(cwd, 'rev-parse', 'HEAD');
  const remote = git(cwd, 'rev-parse', '@{u}');
  const behind = Number(git(cwd, 'rev-list', '--count', 'HEAD..@{u}'));
  const ahead = Number(git(cwd, 'rev-list', '--count', '@{u}..HEAD'));
  const commits = behind ? git(cwd, 'log', '--oneline', '--no-decorate', '-n', '10', 'HEAD..@{u}').split('\n') : [];
  let remoteVersion = null;
  try { remoteVersion = JSON.parse(git(cwd, 'show', '@{u}:package.json')).version; } catch {}
  return { branch, upstream: up.out, head, remote, behind, ahead, commits, version: info.pkg.version, remoteVersion };
}

export function checkNpm(info) {
  const src = updateSource(info);
  const out = must(gitBin(), ['ls-remote', src.url, src.ref || 'HEAD']);
  const latest = out.split('\n')[0]?.split(/\s+/)[0] || null;
  if (!latest) throw new Error(`${src.url} has no ${src.ref || 'HEAD'}`);
  return { ...src, latest, upToDate: src.installed ? latest.startsWith(src.installed) : null, version: info.pkg.version };
}

function reportGit(c, info) {
  log(`burrow ${c.version}: git checkout ${info.root} (branch ${c.branch})`);
  if (!c.behind) {
    log(`Up to date with ${c.upstream} (${short(c.head)})${c.ahead ? `, ${c.ahead} local commit(s) not pushed` : ''}.`);
    return;
  }
  log(`${c.behind} new commit(s) on ${c.upstream} (${short(c.head)} -> ${short(c.remote)}):`);
  for (const l of c.commits) log(`  ${l}`);
  if (c.behind > c.commits.length) log(`  … and ${c.behind - c.commits.length} more`);
  if (c.remoteVersion && c.remoteVersion !== c.version) log(`Version: ${c.version} -> ${c.remoteVersion}`);
  log('Run "burrow update" to install them.');
}

function reportNpm(c, info) {
  log(`burrow ${c.version}: global npm install in ${info.prefix}`);
  if (c.upToDate === true) { log(`Up to date (${short(c.latest)} from ${c.url}).`); return; }
  if (c.upToDate === false) log(`Newer commit available: ${short(c.installed)} -> ${short(c.latest)} (${c.url}).`);
  else log(`Installed commit unknown (not installed from git); latest is ${short(c.latest)} on ${c.url}.`);
  log('Run "burrow update" to install it.');
}

function updateGit(info, opts) {
  const cwd = info.root;
  if (git(cwd, 'status', '--porcelain', '--untracked-files=no')) {
    throw new Error(`${cwd} has local changes. Commit or stash them, then run burrow update again.`);
  }
  const c = checkGit(info);
  if (!c.behind) { log(`Already up to date (${short(c.head)} on ${c.branch}).`); return; }
  if (c.ahead) throw new Error(`${c.branch} has ${c.ahead} local commit(s) that ${c.upstream} doesn't; a fast-forward pull isn't possible.`);
  if (opts.dryRun) {
    log(`[dry-run] ${c.behind} new commit(s). Would run in ${cwd}: git pull --ff-only, then ${npmBin()} install`);
    return;
  }
  must(gitBin(), ['pull', '--ff-only', '--quiet'], { cwd, timeout: PULL_TIMEOUT });
  const now = git(cwd, 'rev-parse', 'HEAD');
  log(`Pulled ${c.behind} commit(s): ${short(c.head)} -> ${short(now)}`);
  log(`Running ${npmBin()} install…`);
  must(npmBin(), ['install', '--no-audit', '--no-fund'], { cwd, timeout: NPM_TIMEOUT, inherit: true });
  log(`burrow is now ${readPkg(cwd).version} (${short(now)}).`);
}

function updateNpm(info, opts) {
  const src = updateSource(info);
  if (!opts.force) {
    let c = null;
    try { c = checkNpm(info); } catch (e) { log(`Couldn't check ${src.url} (${e.message}); reinstalling anyway.`); }
    if (c?.upToDate) { log(`Already up to date (${short(c.latest)}). Use --force to reinstall.`); return; }
  }
  const args = ['install', '-g', src.spec, '--prefix', info.prefix, '--no-audit', '--no-fund'];
  if (opts.dryRun) { log(`[dry-run] would run: ${npmBin()} ${args.join(' ')}`); return; }
  log(`Running: ${npmBin()} ${args.join(' ')}`);
  must(npmBin(), args, { timeout: NPM_TIMEOUT, inherit: true });
  let version = '?';
  try { version = readPkg(info.root).version; } catch {}
  log(`burrow is now ${version}.`);
}

// One object for `update --check --json`: is something newer available, and what.
export function checkSummary(info) {
  const base = { mode: info.mode, version: info.pkg.version, checkedAt: new Date().toISOString() };
  if (info.mode === 'git') {
    const c = checkGit(info);
    return {
      ...base, available: c.behind > 0, branch: c.branch, upstream: c.upstream, head: short(c.head), latest: short(c.remote),
      behind: c.behind, ahead: c.ahead, commits: c.commits, remoteVersion: c.remoteVersion,
    };
  }
  const c = checkNpm(info);
  return { ...base, available: c.upToDate === null ? null : !c.upToDate, head: short(c.installed), latest: short(c.latest), source: c.url };
}

export async function update(opts = {}) {
  const info = detectInstall();
  if (info.mode === 'unknown') {
    let hint = 'npm install -g github:<owner>/burrow';
    try { hint = `npm install -g ${updateSource(info).spec}`; } catch {}
    if (opts.json) { console.log(JSON.stringify({ mode: 'unknown', version: info.pkg.version, available: null, checkedAt: new Date().toISOString() })); return; }
    throw new Error(`Can't tell how burrow at ${info.root} was installed (not a git checkout or a global npm install). Reinstall with: ${hint}`);
  }
  if (opts.json) {
    if (!opts.check) throw new Error('--json only works with --check');
    console.log(JSON.stringify(checkSummary(info)));
    return;
  }
  if (info.mode === 'git') return opts.check ? reportGit(checkGit(info), info) : updateGit(info, opts);
  return opts.check ? reportNpm(checkNpm(info), info) : updateNpm(info, opts);
}
