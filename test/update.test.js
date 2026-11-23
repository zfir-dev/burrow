import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitUrl, updateSource } from '../src/update.js';

// Everything here is local: a bare repo in a temp dir plays "GitHub", and npm is a fake script.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ID = ['-c', 'user.name=burrow-test', '-c', 'user.email=test@example.dev', '-c', 'init.defaultBranch=main'];
const sh = (cwd, bin, args) => {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assert.equal(r.status, 0, `${bin} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const git = (cwd, ...args) => sh(cwd, 'git', [...ID, ...args]);
// The fake release is always one patch above whatever package.json says, so
// these tests keep working after every real version bump.
const CURRENT = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const NEXT = CURRENT.replace(/^(\d+)\.(\d+)\.(\d+).*$/, (_, a, b, c) => `${a}.${b}.${Number(c) + 1}`);
const NEXT_RE = NEXT.replace(/\./g, '\\.');

function copyPackage(dest) {
  mkdirSync(dest, { recursive: true });
  for (const f of ['bin', 'src', 'package.json']) cpSync(join(ROOT, f), join(dest, f), { recursive: true });
}

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'burrow-update-'));
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', origin);
  const seed = join(dir, 'seed');
  copyPackage(seed);
  git(seed, 'init', '-q');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'initial');
  git(seed, 'push', '-q', origin, 'HEAD:main');
  const npmLog = join(dir, 'npm.log');
  const npm = join(dir, 'fake-npm');
  writeFileSync(npm, `#!/bin/sh\necho "$PWD|$*" >> "${npmLog}"\n`);
  chmodSync(npm, 0o755);
  const bump = (version) => {
    const pkg = JSON.parse(readFileSync(join(seed, 'package.json'), 'utf8'));
    pkg.version = version;
    writeFileSync(join(seed, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    git(seed, 'commit', '-qam', `release ${version}`);
    git(seed, 'push', '-q', origin, 'HEAD:main');
    return git(seed, 'rev-parse', 'HEAD');
  };
  const burrow = (root, args, env = {}) => spawnSync(process.execPath, [join(root, 'bin', 'burrow.js'), ...args], {
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL',
    env: { ...process.env, BURROW_NPM: npm, BURROW_UPDATE_SOURCE: '', GIT_CONFIG_GLOBAL: '/dev/null', ...env },
  });
  const npmCalls = () => { try { return readFileSync(npmLog, 'utf8').trim().split('\n'); } catch { return []; } };
  return { dir, origin, seed, bump, burrow, npmCalls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function checkout(w) {
  const co = join(w.dir, 'checkout');
  git(w.dir, 'clone', '-q', w.origin, co);
  symlinkSync(join(ROOT, 'node_modules'), join(co, 'node_modules'));
  return co;
}

test('gitUrl understands npm-style sources', () => {
  assert.deepEqual(gitUrl('github:acme/burrow'), { url: 'https://github.com/acme/burrow.git', ref: null });
  assert.deepEqual(gitUrl('acme/burrow#main'), { url: 'https://github.com/acme/burrow.git', ref: 'main' });
  assert.deepEqual(gitUrl('git+ssh://git@github.com/acme/burrow.git#abc1234'), { url: 'ssh://git@github.com/acme/burrow.git', ref: 'abc1234' });
  assert.deepEqual(gitUrl('/srv/git/burrow.git'), { url: '/srv/git/burrow.git', ref: null });
});

test('updateSource: env, then the npm-resolved git URL, then package.json repository', () => {
  const pkg = { repository: 'github:acme/burrow' };
  assert.equal(updateSource({ pkg }, {}).url, 'https://github.com/acme/burrow.git');
  const resolved = 'git+ssh://git@github.com/acme/burrow.git#0123456789abcdef0123456789abcdef01234567';
  const s = updateSource({ pkg, resolved }, {});
  assert.equal(s.spec, 'git+ssh://git@github.com/acme/burrow.git');
  assert.equal(s.installed, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(updateSource({ pkg, resolved }, { BURROW_UPDATE_SOURCE: 'github:acme/burrow-fork' }).spec, 'github:acme/burrow-fork');
  const own = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(own.repository, 'package.json has a repository to update from');
});

test('git checkout: --check reports new commits, update pulls and runs npm install', () => {
  const w = world();
  try {
    const co = checkout(w);
    let r = w.burrow(co, ['update', '--check']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /git checkout/);
    assert.match(r.stdout, /Up to date with origin\/main/);

    const next = w.bump(NEXT);
    r = w.burrow(co, ['update', '--check']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 new commit\(s\) on origin\/main/);
    assert.match(r.stdout, new RegExp(`release ${NEXT_RE}`));
    assert.match(r.stdout, new RegExp(`Version: \\d+\\.\\d+\\.\\d+ -> ${NEXT_RE}`));
    assert.notEqual(git(co, 'rev-parse', 'HEAD'), next, '--check changes nothing');

    r = w.burrow(co, ['update', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[dry-run\] 1 new commit\(s\)\. Would run .*git pull --ff-only/);
    assert.notEqual(git(co, 'rev-parse', 'HEAD'), next);
    assert.deepEqual(w.npmCalls(), []);

    r = w.burrow(co, ['update']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(co, 'rev-parse', 'HEAD'), next);
    assert.match(r.stdout, /Pulled 1 commit\(s\)/);
    assert.match(r.stdout, new RegExp(`burrow is now ${NEXT_RE}`));
    assert.deepEqual(w.npmCalls(), [`${co}|install --no-audit --no-fund`]);

    r = w.burrow(co, ['update']);
    assert.match(r.stdout, /Already up to date/);
  } finally { w.cleanup(); }
});

test('git checkout with local changes is refused', () => {
  const w = world();
  try {
    const co = checkout(w);
    w.bump(NEXT);
    writeFileSync(join(co, 'package.json'), '{}\n');
    const r = w.burrow(co, ['update']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /has local changes/);
    assert.deepEqual(w.npmCalls(), []);
  } finally { w.cleanup(); }
});

test('global npm install: --check compares commits, update reinstalls into the same prefix', () => {
  const w = world();
  try {
    const first = git(w.seed, 'rev-parse', 'HEAD');
    const prefix = join(w.dir, 'prefix');
    const pkgDir = join(prefix, 'lib', 'node_modules', 'burrow-cli');
    copyPackage(pkgDir);
    symlinkSync(join(ROOT, 'node_modules'), join(pkgDir, 'node_modules'));
    writeFileSync(join(prefix, 'lib', 'node_modules', '.package-lock.json'), JSON.stringify({
      packages: { 'node_modules/burrow-cli': { resolved: `git+file://${w.origin}#${first}` } },
    }));

    let r = w.burrow(pkgDir, ['update', '--check']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /global npm install/);
    assert.match(r.stdout, /Up to date/);

    const next = w.bump(NEXT);
    r = w.burrow(pkgDir, ['update', '--check']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Newer commit available: ${first.slice(0, 7)} -> ${next.slice(0, 7)}`));

    r = w.burrow(pkgDir, ['update', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`would run: \\S+ install -g git\\+file://${w.origin} --prefix ${prefix}`));
    assert.deepEqual(w.npmCalls(), []);

    r = w.burrow(pkgDir, ['update']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(w.npmCalls().length, 1);
    assert.match(w.npmCalls()[0], new RegExp(`\\|install -g git\\+file://${w.origin} --prefix ${prefix} --no-audit --no-fund$`));

    r = w.burrow(pkgDir, ['update', '--dry-run', '--force'], { BURROW_UPDATE_SOURCE: 'github:acme/burrow-fork' });
    assert.match(r.stdout, /install -g github:acme\/burrow-fork --prefix/);
  } finally { w.cleanup(); }
});

test('global npm install from the registry: update checks npm and runs npm i -g burrow-cli@latest', () => {
  const w = world();
  try {
    const prefix = join(w.dir, 'prefix');
    const pkgDir = join(prefix, 'lib', 'node_modules', 'burrow-cli');
    copyPackage(pkgDir);
    symlinkSync(join(ROOT, 'node_modules'), join(pkgDir, 'node_modules'));
    writeFileSync(join(prefix, 'lib', 'node_modules', '.package-lock.json'), JSON.stringify({
      packages: { 'node_modules/burrow-cli': { resolved: 'https://registry.npmjs.org/burrow-cli/-/burrow-cli-0.1.0.tgz' } },
    }));
    const current = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
    // A fake npm that answers `view` with a version and logs everything else.
    const fake = (latest) => {
      const npm = join(w.dir, 'fake-npm-reg');
      writeFileSync(npm, `#!/bin/sh\nif [ "$1" = view ]; then echo ${latest}; exit 0; fi\necho "$PWD|$*" >> "${join(w.dir, 'npm.log')}"\n`);
      chmodSync(npm, 0o755);
      return { BURROW_NPM: npm };
    };

    let r = w.burrow(pkgDir, ['update', '--check'], fake(current));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /global npm install of burrow-cli/);
    assert.match(r.stdout, /Up to date/);
    r = w.burrow(pkgDir, ['update'], fake(current));
    assert.match(r.stdout, /Already up to date/);
    assert.deepEqual(w.npmCalls(), []);

    r = w.burrow(pkgDir, ['update', '--check', '--json'], fake('9.9.9'));
    const j = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(j.available, true);
    assert.equal(j.latest, '9.9.9');

    r = w.burrow(pkgDir, ['update', '--dry-run'], fake('9.9.9'));
    assert.match(r.stdout, new RegExp(`would run: \\S+ install -g burrow-cli@latest --prefix ${prefix}`));
    assert.deepEqual(w.npmCalls(), []);

    r = w.burrow(pkgDir, ['update'], fake('9.9.9'));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(w.npmCalls().length, 1);
    assert.match(w.npmCalls()[0], new RegExp(`\\|install -g burrow-cli@latest --prefix ${prefix} --no-audit --no-fund$`));
  } finally { w.cleanup(); }
});

test('newerVersion compares x.y.z numerically', async () => {
  const { newerVersion } = await import('../src/update.js');
  assert.equal(newerVersion('0.10.0', '0.9.0'), true);
  assert.equal(newerVersion('1.0.0', '1.0.0'), false);
  assert.equal(newerVersion('0.1.0', '0.1.1'), false);
});

test('an unknown install layout explains how to reinstall', () => {
  const w = world();
  try {
    const plain = join(w.dir, 'plain');
    copyPackage(plain);
    symlinkSync(join(ROOT, 'node_modules'), join(plain, 'node_modules'));
    const r = w.burrow(plain, ['update', '--check']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Can't tell how burrow .* was installed.*npm install -g /);
  } finally { w.cleanup(); }
});
