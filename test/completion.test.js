import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, EXAMPLE } from './helpers/cli.js';

const has = (bin) => !spawnSync(bin, ['--version']).error;

test('__complete projects lists remembered, running and local projects', async () => {
  const sb = sandbox();
  try {
    writeFileSync(join(sb.state, 'todo-api.json'), '{}');
    writeFileSync(join(sb.state, 'pixel-notes.pid'), '1');
    writeFileSync(join(sb.state, 'pixel-notes.log'), '');
    copyFileSync(EXAMPLE, join(sb.dir, 'tunnel.yml'));
    const r = await sb.run(['__complete', 'projects']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), ['acme-shop', 'burrow', 'pixel-notes', 'todo-api']);
    const help = await sb.run(['--help']);
    assert.doesNotMatch(help.stdout, /__complete/);
  } finally {
    await sb.cleanup();
  }
});

test('bash completion script is valid and completes commands and projects', { skip: !has('bash') }, async () => {
  const sb = sandbox();
  try {
    const r = await sb.run(['completion', 'bash']);
    assert.equal(r.code, 0, r.stderr);
    const file = join(sb.dir, 'burrow.bash');
    writeFileSync(file, r.stdout);
    assert.equal(spawnSync('bash', ['-n', file]).status, 0);
    assert.match(r.stdout, /complete -F _burrow burrow/);
    assert.match(r.stdout, / up\)\n/);
    assert.match(r.stdout, /burrow __complete projects/);
    writeFileSync(join(sb.state, 'acme-shop.json'), '{}');

    // Run the completion function with a fake `burrow` on PATH.
    const shim = join(sb.dir, 'burrow');
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${join(process.cwd(), 'bin/burrow.js')}" "$@"\n`, { mode: 0o755 });
    const probe = (words, cword) => spawnSync('bash', ['-c', `source ${file}; COMP_WORDS=(${words}); COMP_CWORD=${cword}; _burrow; echo "\${COMPREPLY[*]}"`], {
      encoding: 'utf8', env: { ...sb.env, PATH: `${sb.dir}:${process.env.PATH}` }, cwd: sb.dir,
    }).stdout.trim();
    assert.match(probe('burrow d', 1), /\bdown\b.*\bdestroy\b|\bdestroy\b.*\bdown\b/);
    assert.equal(probe('burrow up ac', 2), 'acme-shop');
    assert.equal(probe('burrow dashboard s', 2), 'status');
    assert.match(probe('burrow up --dr', 2), /--dry-run/);
  } finally {
    await sb.cleanup();
  }
});

test('zsh completion script is valid', { skip: !has('zsh') }, async () => {
  const sb = sandbox();
  try {
    const r = await sb.run(['completion', 'zsh']);
    assert.equal(r.code, 0, r.stderr);
    const file = join(sb.dir, '_burrow');
    writeFileSync(file, r.stdout);
    const check = spawnSync('zsh', ['-n', file], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    assert.match(r.stdout, /^#compdef burrow/);
    assert.match(r.stdout, /'up:create\/reuse tunnel/);
    assert.match(r.stdout, /compdef _burrow burrow/);
  } finally {
    await sb.cleanup();
  }
});

test('unsupported shell', async () => {
  const sb = sandbox();
  try {
    const r = await sb.run(['completion', 'fish']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Unsupported shell "fish"/);
  } finally {
    await sb.cleanup();
  }
});
