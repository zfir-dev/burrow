import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHookCommand } from '../src/doctor.js';
import { parseCommands } from '../src/shell-words.js';

test('parseCommands tags conditions, operators and branch kinds', () => {
  const cmds = parseCommands('if cd web && ./check.sh || ./other; then ./a; elif cd x; then ./b; else ./c; fi');
  const shape = cmds.map((c) => [c.words.map((w) => w.text).join(' '), c.cond || '', c.op, c.branchKind || '']);
  assert.deepEqual(shape, [
    ['cd web', 'start', '', ''], ['./check.sh', 'cont', '&&', ''], ['./other', 'cont', '||', ''],
    ['./a', '', ';', 'then'], ['cd x', 'start', ';', 'elif'], ['./b', '', ';', 'then'], ['./c', '', ';', 'else'],
  ]);
});

test('checkHookCommand follows a cd in if/while/until conditions without running anything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'burrow-cdcond-'));
  try {
    mkdirSync(join(dir, 'web'));
    writeFileSync(join(dir, 'web', 'start.sh'), '#!/bin/sh\ntouch RAN\n');
    chmodSync(join(dir, 'web', 'start.sh'), 0o755);
    const check = (run) => checkHookCommand(run, dir);
    const inWeb = (name) => `${name} not found or not executable in ${join(dir, 'web')}`;
    const inRoot = (name) => `${name} not found or not executable in ${dir}`;

    // The then/do body runs where the condition's cd succeeded.
    assert.deepEqual(check('if cd web; then ./start.sh; fi').problems, []);
    assert.deepEqual(check('if cd web && test -d .; then ./start.sh; fi').problems, []);
    assert.deepEqual(check('while cd web; do ./start.sh; done').problems, []);
    assert.deepEqual(check('until ! cd web; do ./start.sh; done').problems, []);
    assert.deepEqual(check('if cd web; then\n  ./start.sh\nfi').problems, []);
    assert.deepEqual(check('if cd web &&\n  test -d .; then ./start.sh; fi').problems, []);
    assert.deepEqual(check('if cd web; then ./ghost.sh; fi').problems, [inWeb('./ghost.sh')]);

    // A failing cd changes nothing, so else and elif run in the original directory.
    assert.deepEqual(check('if cd web; then ./start.sh; else ./ghost.sh; fi').problems, [inRoot('./ghost.sh')]);
    assert.deepEqual(check('if false; then true; elif cd web; then ./start.sh; fi').problems, []);
    assert.deepEqual(check('if cd web; then true; elif cd nope; then true; fi').problems, [`cd nope: no such directory in ${dir}`]);

    // A cd to a missing directory is reported, in the directory it was tried in.
    assert.deepEqual(check('if cd nope; then true; fi').problems, [`cd nope: no such directory in ${dir}`]);
    assert.deepEqual(check('if cd web && cd nope; then true; fi').problems, [`cd nope: no such directory in ${join(dir, 'web')}`]);

    // Where the condition can end in different directories, the path is left unchecked and said so.
    let r = check('if cd web || true; then ./start.sh; fi');
    assert.deepEqual(r.problems, []);
    assert.match(r.detail, /not checked: \.\/start\.sh/);
    r = check('if cd web; test -d .; then ./ghost.sh; fi');
    assert.deepEqual(r.problems, []);
    assert.match(r.detail, /not checked: \.\/ghost\.sh/);
    r = check('if cd web | cat; then ./ghost.sh; fi');
    assert.match(r.detail, /not checked: \.\/ghost\.sh/);
    r = check('if cd "$APP"; then ./start.sh; fi');
    assert.match(r.detail, /not checked: cd \$APP, \.\/start\.sh/);

    // After the block the directory is still unknown when the condition cd'd.
    r = check('if cd web; then true; fi; ./ghost.sh');
    assert.match(r.detail, /not checked: \.\/ghost\.sh/);
    // ...but a condition without a cd leaves it known.
    assert.deepEqual(check('if test -d web; then true; fi; ./web/start.sh').problems, []);
    assert.deepEqual(check('if test -d web; then true; fi; ./ghost.sh').problems, [inRoot('./ghost.sh')]);
    // A cd in a subshell condition stays in the subshell.
    assert.deepEqual(check('if (cd web && test -d .); then ./web/start.sh; fi').problems, []);

    assert.equal(existsSync(join(dir, 'RAN')), false, 'nothing was executed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
