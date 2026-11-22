import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'burrow-process-'));
process.env.BURROW_STATE_DIR = join(dir, 'state');
const { isAlive, stopConnector, pidFile, startConnector } = await import('../src/process.js');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const fake = join(dir, 'fake-cloudflared');
writeFileSync(fake, '#!/bin/sh\nwhile true; do sleep 1; done\n');
chmodSync(fake, 0o755);

// Swap process.kill for one test; `plan(pid, sig)` may throw or return undefined to pass through.
async function withKill(plan, fn) {
  const real = process.kill;
  process.kill = (pid, sig) => { const r = plan(pid, sig, real); return r === undefined ? real.call(process, pid, sig) : r; };
  try { return await fn(); } finally { process.kill = real; }
}
const esrch = () => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); };

test('isAlive: a pid that answers kill(0) but has no /proc entry is gone (it just exited)', async () => {
  const ghost = 2 ** 22 + 12345; // above pid_max on Linux, so /proc never has it
  await withKill((pid, sig) => (pid === ghost && sig === 0 ? true : undefined), async () => {
    assert.equal(isAlive(ghost), false);
    assert.equal(isAlive(ghost, 'cloudflared', { proc: false }), true, 'without /proc, kill(0) is trusted');
  });
});

test('stopConnector: the process exiting right before SIGTERM is not an error', async () => {
  const pid = startConnector('race-demo', 'token', fake);
  for (let i = 0; i < 50 && !isAlive(pid); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(isAlive(pid));
  // The connector dies on its own between the liveness check and our signal.
  const r = await withKill((p, sig, real) => {
    if (p === pid && sig === 'SIGTERM') { real.call(process, pid, 'SIGKILL'); return esrch(); }
    return undefined;
  }, () => stopConnector('race-demo'));
  assert.equal(r, pid);
  assert.ok(!existsSync(pidFile('race-demo')));
});

test('stopConnector: ESRCH on the SIGKILL fallback is not an error either', async () => {
  const pid = startConnector('race-demo-2', 'token', fake);
  for (let i = 0; i < 50 && !isAlive(pid); i++) await new Promise((r) => setTimeout(r, 20));
  // SIGTERM is ignored (process keeps running), and it is gone by the time SIGKILL is sent.
  const r = await withKill((p, sig, real) => {
    if (p !== pid) return undefined;
    if (sig === 'SIGTERM') return true;
    if (sig === 'SIGKILL') { real.call(process, pid, 'SIGKILL'); return esrch(); }
    return undefined;
  }, () => stopConnector('race-demo-2', 300));
  assert.equal(r, pid);
});

test('stopConnector stops a real connector many times in a row', async () => {
  for (let i = 0; i < 20; i++) {
    const pid = startConnector('loop-demo', 'token', fake);
    for (let j = 0; j < 50 && !isAlive(pid); j++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(await stopConnector('loop-demo'), pid);
    assert.equal(isAlive(pid), false);
  }
});
