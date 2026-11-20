const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const LOGIN_HTML = (message) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>burrow · sign in</title><link rel="stylesheet" href="/app.css"></head>
<body class="login"><form method="post" action="/login" class="card login-card">
<h1>burrow</h1><p class="muted">Tunnel dashboard</p>
${message ? `<p class="error">${esc(message)}</p>` : ''}
<label>Password<input type="password" name="password" autocomplete="current-password" required autofocus></label>
<button type="submit" class="primary">Sign in</button></form></body></html>`;

export const APP_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>burrow</title><link rel="stylesheet" href="/app.css"></head>
<body>
<header><h1>burrow</h1><span id="cf" class="muted"></span><span class="spacer"></span>
<button id="refresh">Refresh</button><button id="logout">Sign out</button></header>
<main>
<section id="list"><p class="muted">Loading…</p></section>
<section id="logs" class="card hidden">
  <div class="logs-head"><h2 id="logs-title">Logs</h2><span class="spacer"></span>
  <label class="muted"><input type="checkbox" id="follow" checked> follow</label>
  <button id="logs-clear">Clear</button><button id="logs-close">Close</button></div>
  <pre id="logs-body"></pre>
</section>
<div id="toast" class="hidden"></div>
</main>
<script src="/app.js"></script></body></html>`;

export const APP_CSS = `
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--text:#e6e8ee;--muted:#8b93a7;--ok:#3ecf8e;--warn:#f5a524;--bad:#f2555a;--accent:#6c8cff}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text)}
header{display:flex;align-items:center;gap:12px;padding:14px 24px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg)}
h1{font-size:18px;margin:0}h2{font-size:15px;margin:0}.spacer{flex:1}.muted{color:var(--muted)}.hidden{display:none!important}
main{max-width:1100px;margin:0 auto;padding:20px 24px;display:grid;gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
#list{display:grid;gap:12px}
.row{display:grid;grid-template-columns:1fr auto;gap:10px}
.title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.name{font-weight:600;font-size:15px}
.pill{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.pill.ok{color:var(--ok);border-color:#1f5f45}.pill.bad{color:var(--bad);border-color:#6b2a2d}.pill.warn{color:var(--warn);border-color:#6b5220}
.hosts{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.hosts a{color:var(--accent);text-decoration:none}.hosts a:hover{text-decoration:underline}
.meta{margin-top:6px;font-size:12px;color:var(--muted)}
.actions{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;justify-content:flex-end}
button{background:#222735;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 12px;font:inherit;cursor:pointer}
button:hover{border-color:#3a4256}button:disabled{opacity:.45;cursor:not-allowed}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--bad)}
.logs-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
#logs-body{margin:0;height:380px;overflow:auto;background:#0b0d11;border:1px solid var(--line);border-radius:8px;padding:10px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
#toast{position:fixed;right:20px;bottom:20px;max-width:520px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;white-space:pre-wrap;font:12px/1.5 ui-monospace,Menlo,monospace}
.login{display:grid;place-items:center;min-height:100vh}.login-card{width:320px;display:grid;gap:12px}
.login-card label{display:grid;gap:6px;color:var(--muted)}
input[type=password]{background:#0b0d11;border:1px solid var(--line);border-radius:8px;padding:8px 10px;color:var(--text);font:inherit}
.error{color:var(--bad);margin:0}
@media(max-width:700px){.row{grid-template-columns:1fr}.actions{justify-content:flex-start}}
`;

export const APP_JS = `
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); for (const k of kids) e.append(k); return e; };
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'X-Burrow': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
let es = null, current = null, toastTimer = null;

function ago(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m ? m + 'm ' + (s % 60) + 's' : s + 's';
}
function toast(text, ms = 6000) {
  const t = $('#toast'); t.textContent = text; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
async function action(p, act) {
  let body;
  if (act === 'destroy') {
    const typed = prompt('This deletes the tunnel burrow-' + p.project + ' and its DNS records.\\nType "' + p.project + '" to confirm:');
    if (typed !== p.project) return;
    body = { confirm: p.project };
  }
  toast(act + ' ' + p.project + '…', 60000);
  const r = await post('/api/tunnels/' + encodeURIComponent(p.project) + '/' + act, body);
  if (r.status === 401) return location.assign('/login');
  const j = await r.json().catch(() => ({}));
  toast((j.ok ? '✓ ' : '✗ ') + act + ' ' + p.project + '\\n' + (j.output || j.error || ''), 10000);
  load();
}
function card(p, now) {
  const tunnel = p.tunnel;
  const st = tunnel ? tunnel.status : 'no tunnel';
  const cls = st === 'healthy' ? 'ok' : st === 'degraded' ? 'warn' : st === 'down' ? 'bad' : '';
  const title = el('div', { className: 'title' },
    el('span', { className: 'name', textContent: p.project }),
    el('span', { className: 'pill ' + (p.running ? 'ok' : ''), textContent: p.running ? 'running' : 'stopped' }),
    el('span', { className: 'pill ' + cls, textContent: 'connector: ' + st }));
  if (p.builtIn) title.append(el('span', { className: 'pill', textContent: 'dashboard' }));
  const hosts = el('div', { className: 'hosts' });
  for (const h of p.hostnames) hosts.append(el('a', { href: 'https://' + h, target: '_blank', rel: 'noopener noreferrer', textContent: h }));
  if (!p.hostnames.length) hosts.append(el('span', { className: 'muted', textContent: 'no hostnames' }));
  const meta = [];
  if (p.running && p.startedAt) meta.push('up ' + ago(now - p.startedAt) + ' (pid ' + p.pid + ')');
  if (tunnel && tunnel.connections.length) {
    const oldest = Math.min(...tunnel.connections.map((c) => Date.parse(c.openedAt)).filter(Boolean));
    meta.push(tunnel.connections.length + ' connection(s) via ' + [...new Set(tunnel.connections.map((c) => c.colo))].join(', ') + (isFinite(oldest) ? ', connected ' + ago(now - oldest) : ''));
  }
  const btn = (label, act, opts = {}) => el('button', { textContent: label, className: opts.cls || '', disabled: !!opts.disabled, title: opts.title || '', onclick: () => action(p, act) });
  const actions = el('div', { className: 'actions' },
    el('button', { textContent: 'Logs', onclick: () => openLogs(p.project) }),
    btn('Up', 'up', { cls: 'primary', disabled: !p.canUp || p.builtIn, title: p.builtIn ? 'Use "burrow dashboard up"' : p.canUp ? '' : 'No remembered tunnel.yml; run burrow up -f on the server' }),
    btn('Down', 'down', { disabled: !p.running || p.builtIn, title: p.builtIn ? 'Stopping this would cut off the dashboard' : '' }),
    btn('Destroy', 'destroy', { cls: 'danger', disabled: p.builtIn }));
  return el('div', { className: 'card row' },
    el('div', {}, title, hosts, el('div', { className: 'meta', textContent: meta.join(' · ') })), actions);
}
async function load() {
  const r = await fetch('/api/tunnels');
  if (r.status === 401) return location.assign('/login');
  const data = await r.json();
  $('#cf').textContent = data.cloudflare.error ? 'Cloudflare: ' + data.cloudflare.error : 'Cloudflare: connected';
  const list = $('#list'); list.replaceChildren();
  if (!data.projects.length) list.append(el('p', { className: 'muted', textContent: 'No burrow tunnels yet. Run "burrow up" in a project with a tunnel.yml.' }));
  for (const p of data.projects) list.append(card(p, data.now));
}
function openLogs(project) {
  if (es) es.close();
  current = project;
  $('#logs').classList.remove('hidden');
  $('#logs-title').textContent = 'Logs · ' + project;
  const body = $('#logs-body'); body.textContent = '';
  es = new EventSource('/api/logs/' + encodeURIComponent(project));
  es.onmessage = (e) => {
    body.append(e.data + '\\n');
    if (body.childNodes.length > 4000) body.firstChild.remove();
    if ($('#follow').checked) body.scrollTop = body.scrollHeight;
  };
  es.onerror = () => { if (es.readyState === 2) body.append('(stream closed)\\n'); };
  $('#logs').scrollIntoView({ behavior: 'smooth' });
}
$('#logs-close').onclick = () => { if (es) es.close(); es = null; current = null; $('#logs').classList.add('hidden'); };
$('#logs-clear').onclick = () => { $('#logs-body').textContent = ''; };
$('#refresh').onclick = load;
$('#logout').onclick = async () => { await post('/logout'); location.assign('/login'); };
load();
setInterval(load, 5000);
`;
