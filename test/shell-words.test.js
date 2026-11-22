import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommands, isAssignment } from '../src/shell-words.js';
import { checkHookCommand } from '../src/doctor.js';

const words = (s) => parseCommands(s).map((c) => [c.words.map((w) => w.text), c.unsupported]);

test('parseCommands splits lists and pipelines, honours quotes and skips redirections', () => {
  assert.deepEqual(words('cd web && npm run dev 2>&1 | tee x.log'), [[['cd', 'web'], null], [['npm', 'run', 'dev'], null], [['tee', 'x.log'], null]]);
  assert.deepEqual(words(`echo "a;b" 'c && d' > out; ./x.sh &`), [[['echo', 'a;b', 'c && d'], null], [['./x.sh'], null]]);
  assert.deepEqual(words('a 2>/dev/null >>log < in || b # comment ; c'), [[['a'], null], [['b'], null]]);
  assert.deepEqual(words('one\ntwo \\\n  three'), [[['one'], null], [['two', 'three'], null]]);
  assert.deepEqual(words('my\\ tool --x'), [[['my tool', '--x'], null]]);
  for (const [s, why] of [['node $(which y)', 'command substitution'], ['node `which y`', 'command substitution'], ['(cd x; make)', 'subshell'],
    ['if true; then x; fi', '"if" block'], ['cat <<EOF', 'here-document'], ["echo 'open", 'unterminated quote'], ['{ a; }', 'command group']]) {
    assert.ok(parseCommands(s).some((c) => c.unsupported === why), `${s} -> ${why}`);
  }
  const [cmd] = parseCommands('FOO="a b" BAR=1 "X=2" npm start');
  assert.deepEqual(cmd.words.map(isAssignment), [true, true, false, false, false]);
  assert.equal(cmd.words[0].text, 'FOO=a b');
  assert.equal(parseCommands('$TOOL run')[0].words[0].expands, true);
});

test('checkHookCommand: PATH, ./scripts, cd, env and wrappers, npm/yarn/pnpm scripts; nothing runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'burrow-hooks-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const t of ['npm', 'yarn', 'pnpm', 'node', 'tee', 'touched']) {
      // `touched` would create a file if anything ran it.
      writeFileSync(join(bin, t), `#!/bin/sh\ntouch ${join(dir, 'RAN')}\n`); chmodSync(join(bin, t), 0o755);
    }
    mkdirSync(join(dir, 'web'));
    writeFileSync(join(dir, 'web', 'package.json'), JSON.stringify({ scripts: { dev: 'vite', start: 'node s.js' } }));
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'warm.sh'), '#!/bin/sh\n'); chmodSync(join(dir, 'scripts', 'warm.sh'), 0o755);
    const check = (run) => checkHookCommand(run, dir, bin);

    assert.deepEqual(check('cd web && npm run dev 2>&1 | tee dev.log').problems, []);
    assert.deepEqual(check('cd web && FOO="a b" npm start').problems, []);
    assert.deepEqual(check('PORT=3000 env -i HOME=/x nohup node server.js &').problems, []);
    assert.deepEqual(check('cd web && yarn dev; pnpm run start').problems, []);
    assert.deepEqual(check('./scripts/warm.sh && export X=1 && echo ok > /dev/null').problems, []);
    assert.deepEqual(check('touched --now').problems, []);

    assert.deepEqual(check('cd web && npm run build').problems, [`npm: no "build" script in ${join(dir, 'web', 'package.json')}`]);
    assert.deepEqual(check('npm run dev').problems, [`npm run dev: no package.json in ${dir}`]);
    assert.deepEqual(check('cd api && make').problems, [`cd api: no such directory in ${dir}`, 'make not found on PATH']);
    assert.deepEqual(check('node a.js | grepx foo').problems, ['grepx not found on PATH']);
    assert.match(check('cd web && ./scripts/warm.sh').problems[0], /\.\/scripts\/warm\.sh not found or not executable in .*web/);
    assert.match(check('MISSING=1 exec ghost-tool').detail, /ghost-tool not found on PATH/);

    let r = check('node $(cat which) && $RUNNER go && tee log');
    assert.equal(r.ok, true);
    assert.match(r.detail, /found: tee; not checked: command substitution, \$RUNNER \(variable\)/);
    r = check('cd "$APP_DIR" && ./start.sh');
    assert.equal(r.ok, true, 'unknown directory: later relative paths are left unchecked');
    assert.match(r.detail, /not checked: cd \$APP_DIR, \.\/start\.sh/);
    assert.equal(check('if [ -f x ]; then node x; fi').ok, true);

    assert.equal(require_exists(join(dir, 'RAN')), false, 'nothing was executed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function require_exists(p) { try { return !!statSyncSafe(p); } catch { return false; } }
import { statSync as statSyncSafe } from 'node:fs';
