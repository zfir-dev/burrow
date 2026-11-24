import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../config.js';
import { pair, serverUrl } from './pair.js';
import { loadCredentials, removeCredentials } from './credentials.js';
import { credentialsFile, defaultServer, policyFile, stateDir } from './paths.js';
import { Executor } from './executor.js';
import { ConnectorClient } from './client.js';
import { LocalBurrow, BURROW_VERSION } from './local-burrow.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { installAiService, uninstallAiService, aiServiceStatus } from './service.js';

const out = (...a) => console.log(...a);

// burrow ai login [code]: pair this machine with burrow-ai using a one-time code from the
// dashboard (Devices page). The device token is stored in ~/.config/burrow/ai/device.json (600).
export async function login(code, opts = {}) {
  const server = serverUrl(opts.server || defaultServer()).origin;
  if (!code) {
    out(`Get a one-time pairing code at ${server}/app/devices (or ask your agent to call create_pairing_code).`);
    if (!process.stdin.isTTY) throw new Error('pairing code required: burrow ai login <code>');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { code = (await rl.question('Pairing code: ')).trim(); } finally { rl.close(); }
    if (!code) throw new Error('no pairing code entered');
  }
  const before = loadCredentials();
  const r = await pair({ code, server, deviceName: opts.name || hostname() });
  if (before) out(`Replaced the previous pairing (${before.deviceName} on ${before.server}).`);
  out(`Paired as "${r.deviceName}" (${r.deviceId}) with ${r.server}.`);
  out(`Device token stored in ${r.file} (mode 600).`);
  out('Next: burrow ai connect   (or keep it running: burrow ai connect --install-service)');
}

// burrow ai connect: the outbound connector. Foreground; Ctrl+C stops it.
export async function connect(opts = {}) {
  if (opts.installService) return installAiService({ dryRun: !!opts.dryRun });
  if (opts.uninstallService) return uninstallAiService({ dryRun: !!opts.dryRun });
  const creds = loadCredentials();
  if (!creds) throw new Error(`not logged in; run "burrow ai login" first (${credentialsFile()})`);
  const log = opts.json
    ? (event, fields = {}) => out(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
    : (event, fields = {}) => out(`${new Date().toISOString()} ${event}${Object.entries(fields).map(([k, v]) => ` ${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('')}`);
  const cfg = loadConfig();
  if (!(cfg.token && cfg.accountId && cfg.domain)) log('warning', { message: 'burrow is not configured yet (run "burrow init"); expose will fail until it is' });
  const executor = new Executor({ burrow: new LocalBurrow(), log });
  await executor.restore();
  const client = new ConnectorClient({ creds, executor, version: BURROW_VERSION, log });
  const stop = async () => { client.stop(); await executor.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  log('starting', { server: creds.server, device: creds.deviceName, protocol: PROTOCOL_VERSION, burrow: BURROW_VERSION });
  try {
    await client.start();
    log('stopped');
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await executor.close();
  }
}

// burrow ai status: the pairing (never the token), the service and this device's exposures.
export async function status(opts = {}) {
  const c = loadCredentials();
  const exposures = new Executor({ burrow: null, policy: { folderRoots: [], denyPorts: [], allowPorts: null } }).list();
  const info = {
    paired: !!c,
    ...(c ? { server: c.server, deviceId: c.deviceId, deviceName: c.deviceName, pairedAt: c.pairedAt } : {}),
    credentials: credentialsFile(), policy: policyFile(), state: stateDir(),
    protocol: PROTOCOL_VERSION, burrowVersion: BURROW_VERSION,
    service: aiServiceStatus(),
    exposures,
  };
  if (opts.json) { out(JSON.stringify(info, null, 2)); return; }
  if (!c) out('Not logged in. Run "burrow ai login".');
  else out(`Paired: ${c.deviceName} (${c.deviceId}) with ${c.server} since ${c.pairedAt}`);
  out(`Credentials: ${info.credentials}`);
  out(`Service: ${info.service}`);
  out(`Protocol: ${PROTOCOL_VERSION} (burrow ${BURROW_VERSION})`);
  if (exposures.length) {
    out('Exposures created by burrow-ai on this device:');
    for (const e of exposures) out(`  ${e.name}  ${e.url}  (${e.kind} ${e.port})`);
  } else out('No exposures created by burrow-ai on this device.');
}

// burrow ai logout: forget the device token. Exposures keep running until stopped.
export async function logout() {
  const c = loadCredentials();
  if (!removeCredentials()) { out('Not logged in.'); return; }
  out(`Removed ${credentialsFile()}.`);
  out(`Also remove "${c.deviceName}" under Devices at ${c.server}/app/devices so its token stops working.`);
}
