// Test helper: start a dashboard on a random port and sign in.
import { createDashboard } from '../../src/dashboard/server.js';

export const PASSWORD = 'correct horse battery';

export async function startDashboard(opts = {}) {
  const logs = [];
  const server = createDashboard({ password: PASSWORD, log: (m) => logs.push(m), ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: PASSWORD }),
  });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const get = (path, headers = {}) => fetch(base + path, { headers: { cookie, ...headers } });
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: 'POST',
    headers: { cookie, 'X-Burrow': '1', 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const close = () => { server.closeAllConnections?.(); return new Promise((res) => server.close(res)); };
  return { server, base, cookie, get, post, close, logs };
}
