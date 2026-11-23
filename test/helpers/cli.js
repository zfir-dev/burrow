// Test helper: run the burrow CLI in a throwaway sandbox (config, state dir,
// fake cloudflared). Nothing here talks to the real Cloudflare API.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../../bin/burrow.js', import.meta.url));
export const EXAMPLE = fileURLToPath(new URL('../../examples/acme-shop.tunnel.yml', import.meta.url));

export const DEAD_API = 'http://127.0.0.1:1';
const CONFIG_KEYS = ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_ZONE_ID', 'BURROW_DOMAIN', 'CLOUDFLARED_BIN'];

export function sandbox({ api, domain = 'example.dev', extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'burrow-cli-'));
  const state = join(dir, 'state');
  mkdirSync(state);
  const fake = join(dir, 'fake-cloudflared');
  writeFileSync(
    fake,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cloudflared version 2026.1.0 (fake)"; exit 0; fi\n' +
      'while true; do sleep 1; done\n'
  );
  chmodSync(fake, 0o755);
  const config = join(dir, 'config.env');
  const values = {
    CF_API_TOKEN: 'test-token', CF_ACCOUNT_ID: 'acct-1', CF_ZONE_ID: 'zone-1',
    BURROW_DOMAIN: domain, CLOUDFLARED_BIN: fake, ...extra,
  };
  writeFileSync(config, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  const env = { ...process.env, BURROW_CONFIG: config, BURROW_STATE_DIR: state };
  for (const k of [...CONFIG_KEYS, ...Object.keys(extra)]) delete env[k];
  // Without a mock, point at a dead local port rather than the real Cloudflare API.
  env.BURROW_CF_API_BASE = api || DEAD_API;

  const start = (args, opts = {}) =>
    spawn(process.execPath, [BIN, ...args], {
      env: { ...env, ...(opts.env || {}) }, cwd: opts.cwd || dir, stdio: ['pipe', 'pipe', 'pipe'],
    });
  const run = (args, opts = {}) =>
    new Promise((resolve) => {
      const child = start(args, opts);
      let stdout = '';
      let stderr = '';
      // Hard limit, so a stuck CLI can never hang the test run.
      const limit = opts.timeout || 60000;
      const timer = setTimeout(() => {
        stderr += `\n[test helper] killed after ${limit} ms`;
        child.kill('SIGKILL');
      }, limit);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.stdin.end(opts.input ?? '');
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  const cleanup = async () => {
    await run(['down']).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, state, config, env, fake, start, run, cleanup };
}
