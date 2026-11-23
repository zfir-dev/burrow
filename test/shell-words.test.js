import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommands, isAssignment } from '../src/shell-words.js';
import { checkHookCommand } from '../src/doctor.js';

const words = (s) => parseCommands(s).map((c) => [c.words.map((w) => w.text), c.unsupported]);
// [text, depth, scope] per command
const shape = (s) => parseCommands(s).map((c) => [c.words.map((w) => w.text).join(' '), c.depth, c.scope]);

test('parseCommands splits lists and pipelines, honours quotes and skips redirections', () => {
  assert.deepEqual(words('cd web && npm run dev 2>&1 | tee x.log'), [[['cd', 'web'], null], [['npm', 'run', 'dev'], null], [['tee', 'x.log'], null]]);
  assert.deepEqual(words(`echo "a;b" 'c && d' > out; ./x.sh &`), [[['echo', 'a;b', 'c && d'], null], [['./x.sh'], null]]);
  assert.deepEqual(words('a 2>/dev/null >>log < in || b # comment ; c'), [[['a'], null], [['b'], null]]);
  assert.deepEqual(words('one\ntwo \\\n  three'), [[['one'], null], [['two', 'three'], null]]);
  assert.deepEqual(words('my\\ tool --x'), [[['my tool', '--x'], null]]);
  for (const [s, why] of [["echo 'open", 'unterminated quote'], ['node $(which y', 'unterminated $('], ['f() { a; }', 'function definition']]) {
    assert.ok(parseCommands(s).some((c) => c.unsupported === why), `${s} -> ${why}`);
  }
  const [cmd] = parseCommands('FOO="a b" BAR=1 "X=2" npm start');
  assert.deepEqual(cmd.words.map(isAssignment), [true, true, false, false, false]);
  assert.equal(cmd.words[0].text, 'FOO=a b');
  assert.equal(parseCommands('$TOOL run')[0].words[0].expands, true);
});

test('parseCommands reads $(…), backticks, subshells and groups', () => {
  assert.deepEqual(shape('node $(which y) "$(cat z)" `date` $((1 + 2))'), [
    ['which y', 0, '/1'], ['cat z', 0, '/2'], ['date', 0, '/3'], ['node $(which y) $(cat z) `date` $((1 + 2))', 0, ''],
  ]);
  assert.deepEqual(shape('echo "$(basename "$(pwd)")"'), [['pwd', 0, '/1/2'], ['basename $(pwd)', 0, '/1'], ['echo $(basename "$(pwd)")', 0, '']]);
  assert.deepEqual(shape('(cd x; make) | tee log; { a; b; } > out'), [['cd x', 0, '/1'], ['make', 0, '/1'], ['tee log', 0, ''], ['a', 0, ''], ['b', 0, '']]);
  assert.deepEqual(shape('cat <<-EOF\n\tnot a command\n\tEOF\nnext'), [['cat', 0, ''], ['next', 0, '']]);
});

test('parseCommands reads if/while/until/for/case bodies and drops reserved words', () => {
  assert.deepEqual(shape('if [ -f x ]; then node x; elif true; then make; else exit 1; fi; npm start'), [
    ['[ -f x ]', 1, ''], ['node x', 1, ''], ['true', 1, ''], ['make', 1, ''], ['exit 1', 1, ''], ['npm start', 0, ''],
  ]);
  assert.deepEqual(shape('for f in a b; do ./run "$f"; done\nuntil ready; do sleep 1; done & echo hi'), [
    ['./run $f', 1, ''], ['ready', 1, ''], ['sleep 1', 1, ''], ['echo hi', 0, ''],
  ]);
  assert.deepEqual(shape('while true\ndo\n  if ok; then go; fi\ndone'), [['true', 1, ''], ['ok', 2, ''], ['go', 2, '']]);
  assert.deepEqual(shape('case "$1" in a|b) node a;; (c) cd web && make ;; *) case x in y) inner;; esac;; esac; after'), [
    ['node a', 1, ''], ['cd web', 1, ''], ['make', 1, ''], ['inner', 2, ''], ['after', 0, ''],
  ]);
  assert.deepEqual(shape('if x; then case $y in z) run;; esac; fi'), [['x', 1, ''], ['run', 2, '']]);
  assert.deepEqual(parseCommands('if a; then\n b; c\nelse d; fi').map((c) => !!c.branchStart), [false, true, false, true]);
});

test('checkHookCommand: PATH, ./scripts, cd, env and wrappers, npm/yarn/pnpm scripts, compound commands; nothing runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'burrow-hooks-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const t of ['npm', 'yarn', 'pnpm', 'node', 'tee', 'touched']) {
      // Each would create a file if anything ran it.
      writeFileSync(join(bin, t), `#!/bin/sh\ntouch ${join(dir, 'RAN')}\n`); chmodSync(join(bin, t), 0o755);
    }
    mkdirSync(join(dir, 'web'));
    writeFileSync(join(dir, 'web', 'package.json'), JSON.stringify({ scripts: { dev: 'vite', start: 'node s.js' } }));
    mkdirSync(join(dir, 'api'));
    writeFileSync(join(dir, 'api', 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    writeFileSync(join(dir, 'api', 'server.js'), '');
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
    assert.deepEqual(check('cd nope && make').problems, [`cd nope: no such directory in ${dir}`, 'make not found on PATH']);
    assert.deepEqual(check('node a.js | grepx foo').problems, ['grepx not found on PATH']);
    assert.match(check('cd web && ./scripts/warm.sh').problems[0], /\.\/scripts\/warm\.sh not found or not executable in .*web/);
    assert.match(check('MISSING=1 exec ghost-tool').detail, /ghost-tool not found on PATH/);

    // npm's default start: reported, not a problem.
    let r = check('cd api && npm start');
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.notes, [`npm start: no "start" script, so npm runs "node server.js" (${join(dir, 'api', 'server.js')})`]);
    assert.match(r.detail, /^found: npm; note: npm start: no "start" script, so npm runs "node server\.js"/);
    assert.deepEqual(check('npm start').problems, [`npm start: no package.json in ${dir}`]);

    // Inside $(…), backticks, subshells, groups and blocks.
    r = check('node $(touched which) && $RUNNER go && "$(ghost-a)" x && tee log');
    assert.deepEqual(r.problems, ['ghost-a not found on PATH']);
    assert.match(r.detail, /not checked: \$RUNNER \(variable\), \$\(ghost-a\) \(command output\)/);
    assert.deepEqual(check('echo "built at `ghost-b`"; (cd web && ghost-c); { ghost-d; }').problems,
      ['ghost-b not found on PATH', 'ghost-c not found on PATH', 'ghost-d not found on PATH']);
    assert.deepEqual(check('if [ -f x ]; then ghost-e; elif ghost-f; then :; else node x; fi').problems, ['ghost-e not found on PATH', 'ghost-f not found on PATH']);
    assert.deepEqual(check('for f in a b; do ghost-g "$f"; done; while ghost-h; do :; done; until false; do ghost-i; done').problems,
      ['ghost-g not found on PATH', 'ghost-h not found on PATH', 'ghost-i not found on PATH']);
    assert.deepEqual(check('case "$MODE" in dev) cd web && npm run dev;; prod|*) cd web && npm run ghost;; esac').problems,
      [`npm: no "ghost" script in ${join(dir, 'web', 'package.json')}`]);

    // cd scoping: a subshell's cd stays inside; after a block with a cd the directory is unknown.
    assert.deepEqual(check('(cd web && npm run dev) && npm run dev').problems, [`npm run dev: no package.json in ${dir}`]);
    assert.deepEqual(check('echo $(cd web) && ./scripts/warm.sh').problems, []);
    assert.deepEqual(check('if [ -n "$X" ]; then cd web && npm run dev; else npm run dev; fi').problems, [`npm run dev: no package.json in ${dir}`]);
    r = check('if [ -d web ]; then cd web; fi; ./scripts/warm.sh');
    assert.deepEqual(r.problems, []);
    assert.match(r.detail, /not checked: \.\/scripts\/warm\.sh/);

    r = check('cd "$APP_DIR" && ./start.sh');
    assert.equal(r.ok, true, 'unknown directory: later relative paths are left unchecked');
    assert.match(r.detail, /not checked: cd \$APP_DIR, \.\/start\.sh/);
    assert.match(check('f() { ghost; }; f').detail, /not checked: function definition/);

    assert.equal(existsSync(join(dir, 'RAN')), false, 'nothing was executed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
