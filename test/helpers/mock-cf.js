// Test helper: a small in-memory mock of the Cloudflare API endpoints burrow uses.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// `zones` replaces the default single zone. `routes` handles extra endpoints first:
// return true from it when it answered (ctx has ok, fail, send, state, p, q, body).
export async function mockCloudflare({ zone = { id: 'zone-1', name: 'example.dev' }, zones, routes } = {}) {
  const state = { tunnels: [], records: [], configs: {}, calls: [] };
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://mock');
    const p = u.pathname;
    const q = u.searchParams;
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    state.calls.push(`${req.method} ${p}`);
    const ok = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result, result_info: { page: 1, total_pages: 1 } }));
    };
    const fail = (status, message) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, errors: [{ code: status, message }] }));
    };
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (routes && (await routes({ method: req.method, p, q, body, ok, fail, send, state }))) return;
    let m;
    if (p === '/user/tokens/verify') return ok({ id: 'tok', status: 'active' });
    if (p === '/zones') return ok((zones || [zone]).filter((z) => !q.get('name') || z.name === q.get('name')));
    if (/^\/accounts\/[^/]+\/cfd_tunnel$/.test(p)) {
      if (req.method === 'POST') {
        const t = { id: randomUUID(), name: body.name, status: 'inactive', connections: [], created_at: new Date().toISOString() };
        state.tunnels.push(t);
        return ok(t);
      }
      return ok(state.tunnels.filter((t) => !t.deleted && (!q.get('name') || t.name === q.get('name'))));
    }
    if ((m = p.match(/^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)(\/[a-z]+)?$/))) {
      const t = state.tunnels.find((x) => x.id === m[1] && !x.deleted);
      if (!t) return fail(404, 'tunnel not found');
      const sub = m[2] || '';
      if (sub === '/token') return ok(`token-${t.id}`);
      if (sub === '/configurations') {
        if (req.method === 'PUT') state.configs[t.id] = body.config;
        return ok({ tunnel_id: t.id, config: state.configs[t.id] || null });
      }
      if (sub === '/connections' && req.method === 'DELETE') { t.connections = []; return ok(null); }
      if (sub === '' && req.method === 'DELETE') { t.deleted = true; return ok(t); }
      if (sub === '' && req.method === 'GET') return ok(t);
    }
    if (/^\/zones\/[^/]+\/dns_records$/.test(p)) {
      if (req.method === 'POST') {
        const r = { id: randomUUID(), ...body };
        state.records.push(r);
        return ok(r);
      }
      return ok(state.records.filter((r) =>
        (!q.get('name') || r.name === q.get('name')) &&
        (!q.get('comment.exact') || r.comment === q.get('comment.exact')) &&
        (!q.get('comment.startswith') || String(r.comment || '').startsWith(q.get('comment.startswith')))));
    }
    if ((m = p.match(/^\/zones\/[^/]+\/dns_records\/([^/]+)$/))) {
      const i = state.records.findIndex((r) => r.id === m[1]);
      if (i < 0) return fail(404, 'record not found');
      if (req.method === 'DELETE') { state.records.splice(i, 1); return ok({ id: m[1] }); }
      if (req.method === 'PUT') { state.records[i] = { id: m[1], ...body }; return ok(state.records[i]); }
    }
    return fail(404, `no mock route for ${req.method} ${p}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    live: () => state.tunnels.filter((t) => !t.deleted),
    close: () => new Promise((r) => server.close(r)),
  };
}
