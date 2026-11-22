import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const configPath = () =>
  process.env.BURROW_CONFIG || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'burrow', 'config.env');

export const stateDir = () =>
  process.env.BURROW_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'burrow');

export const TEMPLATE = `# burrow config. Keep this file private (chmod 600). Never commit it.
# API token: dash.cloudflare.com/profile/api-tokens -> Create Custom Token
#   Account > Cloudflare Tunnel > Edit
#   Zone    > DNS               > Edit   (zone: your tunnel domain)
#   Zone    > Analytics         > Read   (optional, only for burrow stats)
#   Zone    > Zone              > Read   (optional, only if CF_ZONE_ID is empty)
#   Account > Access: Apps and Policies > Edit   (optional, only for private: true)
CF_API_TOKEN=
# Account ID: dashboard -> domain overview -> right sidebar
CF_ACCOUNT_ID=
# Zone ID of BURROW_DOMAIN (optional; resolved from BURROW_DOMAIN when empty)
CF_ZONE_ID=
# Tunnel domain. Hostnames: <project>.<domain>, <service>-<project>.<domain>
BURROW_DOMAIN=
# Default allow list for services with private: true (comma-separated emails or @domains)
BURROW_ACCESS_EMAILS=
# Dashboard login (burrow dashboard). At least 12 characters.
BURROW_DASHBOARD_PASSWORD=
BURROW_DASHBOARD_PORT=7070
# Projects "burrow service" brings up at boot (comma-separated), besides autostart: true
BURROW_AUTOSTART=
# Optional path to the cloudflared binary
CLOUDFLARED_BIN=cloudflared
`;

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function loadConfig() {
  const path = configPath();
  const file = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  const pick = (k) => process.env[k] || file[k] || '';
  return {
    path,
    exists: existsSync(path),
    token: pick('CF_API_TOKEN'),
    accountId: pick('CF_ACCOUNT_ID'),
    zoneId: pick('CF_ZONE_ID'),
    domain: pick('BURROW_DOMAIN').toLowerCase().replace(/\.$/, ''),
    accessEmails: pick('BURROW_ACCESS_EMAILS'),
    cloudflared: pick('CLOUDFLARED_BIN') || 'cloudflared',
    dashboardPassword: pick('BURROW_DASHBOARD_PASSWORD'),
    dashboardPort: pick('BURROW_DASHBOARD_PORT') || '7070',
    autostart: pick('BURROW_AUTOSTART'),
  };
}

export function requireConfig(cfg, keys) {
  const map = { token: 'CF_API_TOKEN', accountId: 'CF_ACCOUNT_ID', domain: 'BURROW_DOMAIN' };
  const missing = keys.filter((k) => !cfg[k]).map((k) => map[k] || k);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(', ')} in ${cfg.path}. Run "burrow init" and fill it in.`);
  }
}

export function writeTemplate(path = configPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, TEMPLATE, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return path;
}
