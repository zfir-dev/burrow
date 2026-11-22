// Dashboard UI: Pico CSS for styling, Alpine.js (CSP build, no unsafe-eval)
// for state. Both are vendored from node_modules and served by the server.
// Optional features ("panels", see ./panels/README.md) add HTML at the ${s('...')} slots.
import { slot } from './panels.js';
import { totpEnabled } from './totp.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const head = (title, scripts, styles = []) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${title}</title>
<link rel="stylesheet" href="/vendor/pico.min.css"><link rel="stylesheet" href="/app.css">
${styles.map((s) => `<link rel="stylesheet" href="${s}">`).join('')}
${scripts.map((s) => `<script defer src="${s}"></script>`).join('')}
<script defer src="/vendor/alpine.min.js"></script></head>`;

export const LOGIN_HTML = (message, twoFactor = totpEnabled()) => `${head('burrow · sign in', ['/login.js'])}
<body><main class="container login">
<article x-data="login" data-message="${esc(message)}">
  <hgroup><h1>burrow</h1><p>Tunnel dashboard</p></hgroup>
  <form method="post" action="/login" @submit.prevent="submit">
    <p class="error" x-show="hasError" x-text="error">${esc(message)}</p>
    <input type="password" name="password" x-model="password" placeholder="Password" aria-label="Password"
      autocomplete="current-password" required autofocus>${twoFactor ? `
    <input type="text" name="code" x-model="code" placeholder="6-digit code" aria-label="Two-factor code"
      inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" autocomplete="one-time-code" required>` : ''}
    <button type="submit" :aria-busy="busy" :disabled="busy">Sign in</button>
  </form>
</article></main></body></html>`;

export const renderApp = (panels = []) => {
  const s = (name) => slot(panels, name);
  return `${head('burrow', ['/app.js', '/panels.js'], ['/panels.css'])}
<body x-data="dashboard">
<header class="container-fluid wide"><nav>
  <ul><li><strong>burrow</strong></li><li><small :class="cfClass" x-text="cfText"></small></li></ul>
  <ul>
    ${s('toolbar')}
    <li><button class="secondary outline" @click="load">Refresh</button></li>
    <li><button class="contrast outline" @click="logout">Sign out</button></li>
  </ul>
</nav></header>

<main class="container-fluid wide">
  <p x-show="loading" aria-busy="true">Loading…</p>
  <article x-show="empty">No burrow tunnels yet. Run <code>burrow up</code> in a project with a <code>tunnel.yml</code>.</article>

  <div class="overflow-auto" x-show="hasProjects">
  <table class="striped">
    <thead><tr>${s('headLead')}<th>Project</th><th>Hostnames</th><th>Local</th><th>Connector</th><th>Uptime</th>${s('headCols')}<th></th></tr></thead>
    <tbody>
    <template x-for="p in projects" :key="p.project">
      <tr>
        ${s('rowLead')}
        <td><strong x-text="p.project"></strong> <span class="badge" x-show="p.builtIn">dashboard</span>${s('rowBadges')}</td>
        <td>
          <template x-for="h in p.hostnames" :key="h">
            <div class="host"><a :href="hostUrl(h)" target="_blank" rel="noopener noreferrer" x-text="h"></a>${s('hostExtras')}</div>
          </template>
          <small x-show="noHosts(p)">none</small>
        </td>
        <td><span class="badge" :class="localClass(p)" x-text="localText(p)"></span><br><small x-text="pidText(p)"></small>${s('localExtras')}</td>
        <td><span class="badge" :class="connClass(p)" x-text="connStatus(p)"></span><br><small x-text="connInfo(p)"></small></td>
        <td x-text="uptime(p)"></td>
        ${s('rowCols')}
        <td><div class="actions">
          ${s('rowActions')}
          <button class="secondary outline" @click="openLogs(p)">Logs</button>
          <button :disabled="upDisabled(p)" :title="upTitle(p)" :aria-busy="isBusy(p)" @click="act(p, 'up')">Up</button>
          <button class="secondary" :disabled="downDisabled(p)" :title="downTitle(p)" @click="act(p, 'down')">Down</button>
          <button class="danger outline" :disabled="p.builtIn" @click="askDestroy(p)">Destroy</button>
        </div></td>
      </tr>
    </template>
    </tbody>
  </table>
  </div>

  <article x-show="logOpen" class="logs">
    <header class="logs-head">
      <strong x-text="logTitle"></strong>
      <span class="spacer"></span>
      <label><input type="checkbox" role="switch" x-model="follow"> Follow</label>
      <button class="secondary outline" @click="clearLogs">Clear</button>
      <button class="secondary outline" @click="closeLogs">Close</button>
    </header>
    <pre x-ref="logbody" x-text="logText"></pre>
  </article>
  ${s('sections')}
</main>

<dialog :open="destroyOpen">
  <article>
    <header><strong>Destroy <span x-text="destroyName"></span>?</strong></header>
    <p>This stops cloudflared and deletes the tunnel <code x-text="destroyTunnel"></code> and its DNS records.
      Type <strong x-text="destroyName"></strong> to confirm.</p>
    <input type="text" x-model="confirmText" :placeholder="destroyName" aria-label="Project name" autocomplete="off">
    <footer>
      <button class="secondary" @click="closeDestroy">Cancel</button>
      <button class="danger" :disabled="cannotDestroy" @click="confirmDestroy">Destroy</button>
    </footer>
  </article>
</dialog>

${s('dialogs')}
<article class="toast" x-show="toastOpen" :class="toastClass" @click="hideToast"><pre x-text="toastText"></pre></article>
</body></html>`;
};
export const APP_HTML = renderApp([]);

export const APP_CSS = `
.login{min-height:100vh;display:grid;place-items:center}.login article{width:min(360px,100%)}
.error{color:var(--pico-del-color)}
.badge{display:inline-block;font-size:.75rem;line-height:1.4;padding:.1rem .5rem;border-radius:999px;
  border:1px solid var(--pico-muted-border-color);color:var(--pico-muted-color);white-space:nowrap}
.badge.ok{color:#1f9d55;border-color:#1f9d55}.badge.warn{color:#d97706;border-color:#d97706}.badge.bad{color:#dc2626;border-color:#dc2626}
tbody td{white-space:nowrap;vertical-align:middle}
.actions{display:flex;gap:.4rem;flex-wrap:nowrap;justify-content:flex-end}
.actions button{padding:.25rem .6rem;font-size:.8rem;margin:0;width:auto}
.wide{max-width:1400px;margin-inline:auto}
tbody td,thead th{padding-inline:.5rem}
table{font-size:.875rem}
.actions{gap:.3rem}
button.danger{--pico-background-color:#dc2626;--pico-border-color:#dc2626;--pico-color:#fff}
button.danger.outline{--pico-background-color:transparent;--pico-color:#dc2626}
td small{color:var(--pico-muted-color)}
.logs-head{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}.logs-head label{margin:0}
.logs-head button{width:auto;margin:0;padding:.3rem .7rem;font-size:.85rem}.spacer{flex:1}
.logs pre{height:420px;overflow:auto;margin:0;padding:.75rem;font-size:.78rem;white-space:pre-wrap;word-break:break-all}
.toast{position:fixed;right:1rem;bottom:1rem;max-width:min(560px,calc(100% - 2rem));margin:0;cursor:pointer;z-index:10}
.toast pre{margin:0;max-height:40vh;overflow:auto;font-size:.78rem;white-space:pre-wrap;background:transparent;padding:0}
.toast.ok{border-left:4px solid #1f9d55}.toast.bad{border-left:4px solid #dc2626}
.host{display:flex;align-items:center;gap:.35rem}
`;

export const LOGIN_JS = `
document.addEventListener('alpine:init', function () {
  Alpine.data('login', function () {
    return {
      password: '', code: '', error: '', busy: false,
      init: function () { this.error = this.$el.dataset.message || ''; },
      get hasError() { return this.error.length > 0; },
      submit: async function () {
        this.busy = true; this.error = '';
        try {
          var r = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({ password: this.password, code: this.code }),
          });
          var j = await r.json().catch(function () { return {}; });
          if (r.ok && j.ok) { location.assign('/'); return; }
          this.error = j.error || ('Sign in failed (' + r.status + ')');
          this.password = ''; this.code = '';
          if (j.twoFactor && !document.querySelector('input[name=code]')) { location.reload(); return; }
        } catch (e) {
          this.error = 'Network error';
        } finally { this.busy = false; }
      },
    };
  });
});
`;

export const APP_JS = `
function ago(ms) {
  if (!(ms > 0)) ms = 0;
  var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m ? m + 'm ' + (s % 60) + 's' : s + 's';
}
function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'X-Burrow': '1', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
}
// GET JSON; a 401 sends the browser back to the login page.
async function getJson(url) {
  var r = await fetch(url);
  if (r.status === 401) { location.assign('/login'); throw new Error('login required'); }
  var j = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
var MAX_LOG_LINES = 3000;

// Panels (/panels.js) register mixins here before Alpine starts.
var BURROW_PANELS = [];
function burrowPanel(factory) { BURROW_PANELS.push(factory); }
function mergePanels(base, hooks) {
  BURROW_PANELS.forEach(function (factory) {
    var mixin = factory();
    Object.keys(Object.getOwnPropertyDescriptors(mixin)).forEach(function (k) {
      var d = Object.getOwnPropertyDescriptor(mixin, k);
      if (k === 'init' || k === 'onLoad') { hooks[k].push(d.value); return; }
      Object.defineProperty(base, k, d);
    });
  });
  return base;
}

document.addEventListener('alpine:init', function () {
  Alpine.data('dashboard', function () {
    var hooks = { init: [], onLoad: [] };
    return mergePanels({
      projects: [], loading: true, now: Date.now(), cf: { error: null }, busy: {},
      logOpen: false, logProject: '', logLines: [], follow: true, es: null,
      destroyOpen: false, destroyName: '', confirmText: '',
      toastOpen: false, toastText: '', toastOk: true, toastTimer: null, timer: null,

      init: function () {
        var self = this;
        this.load();
        this.timer = setInterval(function () { self.load(); }, 5000);
        hooks.init.forEach(function (f) { f.call(self); });
      },
      load: async function () {
        try {
          var r = await fetch('/api/tunnels');
          if (r.status === 401) { location.assign('/login'); return; }
          var data = await r.json();
          this.projects = data.projects; this.cf = data.cloudflare; this.now = data.now;
          var self = this;
          hooks.onLoad.forEach(function (f) { try { f.call(self, data); } catch (e) { console.error(e); } });
        } catch (e) {
          this.cf = { error: 'dashboard unreachable' };
        } finally { this.loading = false; }
      },

      get hasProjects() { return this.projects.length > 0; },
      get empty() { return !this.loading && this.projects.length === 0; },
      get cfText() { var e = this.cf.error; return e ? (/^Cloudflare/.test(e) ? e : 'Cloudflare: ' + e) : 'Cloudflare: connected'; },
      get cfClass() { return this.cf.error ? 'error' : ''; },

      hostUrl: function (h) { return 'https://' + h; },
      noHosts: function (p) { return p.hostnames.length === 0; },
      localText: function (p) { return p.running ? 'running' : 'stopped'; },
      localClass: function (p) { return p.running ? 'ok' : ''; },
      pidText: function (p) { return p.pid ? 'pid ' + p.pid : ''; },
      connStatus: function (p) { return p.tunnel ? p.tunnel.status : 'no tunnel'; },
      connClass: function (p) {
        var s = p.tunnel && p.tunnel.status;
        return s === 'healthy' ? 'ok' : s === 'degraded' ? 'warn' : s === 'down' ? 'bad' : '';
      },
      connInfo: function (p) {
        if (!p.tunnel || !p.tunnel.connections.length) return '';
        var colos = [];
        p.tunnel.connections.forEach(function (c) { if (colos.indexOf(c.colo) < 0) colos.push(c.colo); });
        return p.tunnel.connections.length + ' conn · ' + colos.join(', ');
      },
      uptime: function (p) {
        if (p.running && p.startedAt) return ago(this.now - p.startedAt);
        if (p.tunnel && p.tunnel.connections.length) {
          var t = Math.min.apply(null, p.tunnel.connections.map(function (c) { return Date.parse(c.openedAt) || Infinity; }));
          if (isFinite(t)) return ago(this.now - t);
        }
        return '—';
      },
      isBusy: function (p) { return !!this.busy[p.project]; },
      upDisabled: function (p) { return p.builtIn || !p.canUp || this.isBusy(p); },
      upTitle: function (p) {
        if (p.builtIn) return 'Use "burrow dashboard up" on the server';
        return p.canUp ? '' : 'No remembered tunnel.yml; run "burrow up -f <file>" on the server once';
      },
      downDisabled: function (p) { return p.builtIn || !p.running || this.isBusy(p); },
      downTitle: function (p) { return p.builtIn ? 'Stopping this would cut off the dashboard' : ''; },

      showToast: function (text, ok, ms) {
        var self = this;
        this.toastText = text; this.toastOk = ok; this.toastOpen = true;
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(function () { self.toastOpen = false; }, ms || 8000);
      },
      hideToast: function () { this.toastOpen = false; },
      get toastClass() { return this.toastOk ? 'ok' : 'bad'; },

      act: async function (p, action, body) {
        this.busy[p.project] = true;
        this.showToast(action + ' ' + p.project + '…', true, 120000);
        try {
          var r = await post('/api/tunnels/' + encodeURIComponent(p.project) + '/' + action, body);
          if (r.status === 401) { location.assign('/login'); return; }
          var j = await r.json().catch(function () { return {}; });
          this.showToast((j.ok ? '✓ ' : '✗ ') + action + ' ' + p.project + '\\n' + (j.output || j.error || ''), !!j.ok, 12000);
        } catch (e) {
          this.showToast('✗ ' + action + ' ' + p.project + ': network error', false);
        } finally {
          this.busy[p.project] = false;
          this.load();
        }
      },

      askDestroy: function (p) { this.destroyName = p.project; this.confirmText = ''; this.destroyOpen = true; },
      closeDestroy: function () { this.destroyOpen = false; this.confirmText = ''; },
      get destroyTunnel() { return 'burrow-' + this.destroyName; },
      get cannotDestroy() { return this.confirmText !== this.destroyName; },
      confirmDestroy: function () {
        if (this.cannotDestroy) return;
        var name = this.destroyName;
        this.closeDestroy();
        this.act({ project: name }, 'destroy', { confirm: name });
      },

      get logTitle() { return 'Logs · ' + this.logProject; },
      get logText() { return this.logLines.join('\\n'); },
      openLogs: function (p) {
        var self = this;
        this.closeLogs();
        this.logProject = p.project; this.logLines = []; this.logOpen = true;
        this.es = new EventSource('/api/logs/' + encodeURIComponent(p.project));
        this.es.onmessage = function (e) {
          self.logLines.push(e.data);
          if (self.logLines.length > MAX_LOG_LINES) self.logLines.splice(0, self.logLines.length - MAX_LOG_LINES);
          if (self.follow) self.$nextTick(function () { var el = self.$refs.logbody; el.scrollTop = el.scrollHeight; });
        };
        this.es.onerror = function () { if (self.es && self.es.readyState === 2) self.logLines.push('(stream closed)'); };
      },
      clearLogs: function () { this.logLines = []; },
      closeLogs: function () { if (this.es) this.es.close(); this.es = null; this.logOpen = false; },

      logout: async function () { await post('/logout'); location.assign('/login'); },
    }, hooks);
  });
});
`;
