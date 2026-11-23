// Minimal Cloudflare API v4 client. Never logs the token.
const DEFAULT_BASE = 'https://api.cloudflare.com/client/v4';
// BURROW_CF_API_BASE (environment only) points burrow at a mock API for tests
// and the README screenshots. Never set it in normal use.
// Under `node --test` (NODE_TEST_CONTEXT is set, also in spawned CLIs) the real
// API is refused outright, so a test can never touch a real account.
export function apiBase(env = process.env) {
  const b = env.BURROW_CF_API_BASE || DEFAULT_BASE;
  if (env.NODE_TEST_CONTEXT) {
    let host = '';
    try { host = new URL(b).hostname; } catch {}
    if (host === 'cloudflare.com' || host.endsWith('.cloudflare.com')) {
      throw new CloudflareError(`Refusing to call the real Cloudflare API (${host}) from a test: set BURROW_CF_API_BASE to a mock`);
    }
  }
  return b;
}
const base = () => apiBase();

export class CloudflareError extends Error {}

export class Cloudflare {
  constructor({ token, accountId, zoneId }) {
    this.token = token;
    this.accountId = accountId;
    this.zoneId = zoneId;
  }

  async req(method, path, { query, body, allow404 = false } = {}) {
    const url = new URL(base() + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allow404 && res.status === 404) return null;
    let json;
    try { json = await res.json(); } catch { json = null; }
    if (!res.ok || !json || json.success === false) {
      const errs = (json?.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ');
      throw new CloudflareError(`${method} ${path} failed (HTTP ${res.status})${errs ? ` - ${errs}` : ''}`);
    }
    return json;
  }

  async all(path, query = {}) {
    const out = [];
    for (let page = 1; ; page++) {
      const j = await this.req('GET', path, { query: { ...query, page, per_page: query.per_page || 100 } });
      out.push(...(j.result || []));
      const info = j.result_info;
      if (!info || !info.total_pages || page >= info.total_pages) break;
    }
    return out;
  }

  // Tokens
  async verifyToken() {
    try {
      return (await this.req('GET', '/user/tokens/verify')).result;
    } catch (e) {
      if (!this.accountId) throw e;
      // Account-owned tokens verify on the account endpoint.
      return (await this.req('GET', `/accounts/${this.accountId}/tokens/verify`)).result;
    }
  }

  // Zones
  async resolveZoneId(domain) {
    if (this.zoneId) return this.zoneId;
    const zones = await this.all('/zones', { name: domain });
    if (!zones.length) {
      throw new CloudflareError(`Zone ${domain} not found. Set CF_ZONE_ID or grant the token Zone > Zone > Read.`);
    }
    this.zoneId = zones[0].id;
    return this.zoneId;
  }

  // Tunnels
  async findTunnel(name) {
    const list = await this.all(`/accounts/${this.accountId}/cfd_tunnel`, { name, is_deleted: false });
    return list.find((t) => t.name === name) || null;
  }
  listTunnels() {
    return this.all(`/accounts/${this.accountId}/cfd_tunnel`, { is_deleted: false });
  }
  async createTunnel(name, secret) {
    const j = await this.req('POST', `/accounts/${this.accountId}/cfd_tunnel`, {
      body: { name, config_src: 'cloudflare', tunnel_secret: secret },
    });
    return j.result;
  }
  async getTunnelToken(id) {
    return (await this.req('GET', `/accounts/${this.accountId}/cfd_tunnel/${id}/token`)).result;
  }
  async putTunnelConfig(id, ingress) {
    return (await this.req('PUT', `/accounts/${this.accountId}/cfd_tunnel/${id}/configurations`, {
      body: { config: { ingress } },
    })).result;
  }
  async getTunnelConfig(id) {
    return (await this.req('GET', `/accounts/${this.accountId}/cfd_tunnel/${id}/configurations`)).result;
  }
  deleteTunnelConnections(id) {
    return this.req('DELETE', `/accounts/${this.accountId}/cfd_tunnel/${id}/connections`, { allow404: true });
  }
  deleteTunnel(id) {
    return this.req('DELETE', `/accounts/${this.accountId}/cfd_tunnel/${id}`, { allow404: true });
  }

  // DNS
  recordsByName(name) {
    return this.all(`/zones/${this.zoneId}/dns_records`, { name });
  }
  recordsByComment(comment) {
    return this.all(`/zones/${this.zoneId}/dns_records`, { 'comment.exact': comment });
  }
  recordsByCommentPrefix(prefix) {
    return this.all(`/zones/${this.zoneId}/dns_records`, { 'comment.startswith': prefix });
  }
  async createRecord(rec) {
    return (await this.req('POST', `/zones/${this.zoneId}/dns_records`, { body: rec })).result;
  }
  async updateRecord(id, rec) {
    return (await this.req('PUT', `/zones/${this.zoneId}/dns_records/${id}`, { body: rec })).result;
  }
  deleteRecord(id) {
    return this.req('DELETE', `/zones/${this.zoneId}/dns_records/${id}`, { allow404: true });
  }
}
