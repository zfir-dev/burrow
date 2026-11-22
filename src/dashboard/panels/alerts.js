// Panel: alerts. Shows and configures `burrow watch`: the alert channels (webhook,
// ntfy), its systemd unit, a test alert, and the last state it saw per project.
// Channel values are secrets: they're written to the config file but never sent back.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings, sendAlert, watchStateFile, WATCH_UNIT } from '../../watch.js';
import { unitDir } from '../../service.js';
import { setConfigValues } from '../../config-file.js';

export const order = 70;
const KEYS = { webhook: 'BURROW_ALERT_WEBHOOK', ntfy: 'BURROW_ALERT_NTFY', ntfyToken: 'BURROW_ALERT_NTFY_TOKEN' };

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
export function webhookKind(url) {
  const host = hostOf(url);
  if (host === 'hooks.slack.com') return 'Slack';
  if (/(^|\.)discord(app)?\.com$/.test(host)) return 'Discord';
  return 'JSON';
}

export function validate(field, value) {
  if (value === '') return;
  if (value.length > 500 || /\s/.test(value)) throw new Error(`${field}: no spaces, at most 500 characters`);
  if (field === 'webhook' && !/^https?:\/\/[^/]+/.test(value)) throw new Error('webhook must be an http(s) URL');
  if (field === 'ntfy' && !/^https?:\/\/[^/]+\/[^/]+/.test(value) && !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error('ntfy must be a topic name (letters, digits, - and _) or a full topic URL');
  }
}

function unitState() {
  const installed = existsSync(join(unitDir(), WATCH_UNIT));
  const r = spawnSync(process.env.BURROW_SYSTEMCTL || 'systemctl', ['--user', 'is-active', WATCH_UNIT], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
  const active = r.error ? 'unknown' : (r.stdout || '').trim() || 'unknown';
  return { installed, active };
}

function readWatchState() { try { return JSON.parse(readFileSync(watchStateFile(), 'utf8')); } catch { return {}; } }

export function overview(env = process.env) {
  const s = settings(env);
  const ntfyServer = !s.ntfy ? '' : /^https?:\/\//.test(s.ntfy) ? hostOf(s.ntfy) : 'ntfy.sh';
  return {
    channels: {
      webhook: { set: !!s.webhook, kind: s.webhook ? webhookKind(s.webhook) : '', host: hostOf(s.webhook), fromEnv: !!env[KEYS.webhook] },
      ntfy: { set: !!s.ntfy, server: ntfyServer, fromEnv: !!env[KEYS.ntfy] },
      ntfyToken: { set: !!s.ntfyToken, fromEnv: !!env[KEYS.ntfyToken] },
    },
    service: unitState(),
    watch: Object.entries(readWatchState()).map(([project, st]) => ({ project, ...st })).sort((a, b) => a.project.localeCompare(b.project)),
  };
}

export async function route(ctx) {
  const { method, path } = ctx;
  if (method === 'GET' && path === '/api/alerts') return ctx.json(200, overview()) ?? true;
  if (method !== 'POST' || !path.startsWith('/api/alerts/')) return false;
  const body = await ctx.readJson(4096);
  if (!body) return ctx.json(400, { error: 'invalid JSON' }) ?? true;

  if (path === '/api/alerts/config') {
    const updates = {};
    try {
      for (const [field, key] of Object.entries(KEYS)) {
        if (body[field] === undefined) continue;
        const value = body[field] === null ? '' : String(body[field]).trim();
        validate(field, value);
        updates[key] = value;
      }
      if (!Object.keys(updates).length) throw new Error('nothing to change');
      setConfigValues(updates);
    } catch (e) { return ctx.json(400, { error: e.message }) ?? true; }
    // Log which settings changed, never their values.
    ctx.log(`alert settings changed: ${Object.keys(updates).join(', ')} (requested from ${ctx.clientIp})`);
    ctx.events.emit('event', { action: 'alerts config', ok: true, detail: Object.keys(updates).join(', ') });
    return ctx.json(200, { ok: true, ...overview() }) ?? true;
  }

  if (path === '/api/alerts/test') {
    const s = settings();
    if (!s.webhook && !s.ntfy) return ctx.json(400, { error: 'No alert channel set yet' }) ?? true;
    const errors = [];
    const failed = await sendAlert({
      project: 'burrow-test', from: 'ok', to: 'degraded', at: Date.now(), hostnames: [],
      problems: ['this is a test alert from the burrow dashboard'],
    }, s, { report: (m) => errors.push(m) });
    return ctx.json(failed ? 502 : 200, { ok: !failed, errors }) ?? true;
  }

  if (path === '/api/alerts/service') {
    let args;
    if (body.action === 'install') {
      const interval = parseInt(body.interval ?? 60, 10);
      const debounce = parseInt(body.debounce ?? 2, 10);
      if (!(interval >= 10 && interval <= 86400)) return ctx.json(400, { error: 'interval: 10 to 86400 seconds' }) ?? true;
      if (!(debounce >= 1 && debounce <= 20)) return ctx.json(400, { error: 'debounce: 1 to 20 checks' }) ?? true;
      args = ['watch', '--install-service', '--interval', String(interval), '--debounce', String(debounce)];
    } else if (body.action === 'uninstall') {
      if (body.confirm !== true) return ctx.json(400, { error: 'confirm the uninstall' }) ?? true;
      args = ['watch', '--uninstall-service'];
    } else return ctx.json(400, { error: 'action must be install or uninstall' }) ?? true;
    const r = await ctx.runCli(args, 60000);
    return ctx.json(r.ok ? 200 : 500, { ...r, ...overview() }) ?? true;
  }
  return false;
}

export const html = {
  toolbar: '<li><button class="secondary outline" @click="openAlerts">Alerts</button></li>',
  sections: `
<article x-show="alertsOpen" class="alerts">
  <header class="logs-head">
    <strong>Alerts</strong><small class="muted">burrow watch</small>
    <span class="spacer"></span>
    <button class="secondary outline" @click="loadAlerts">Refresh</button>
    <button class="secondary outline" @click="closeAlerts">Close</button>
  </header>
  <p class="error" x-show="hasAlertsError" x-text="alertsError"></p>
  <div class="grid alerts-grid">
    <section>
      <h6>Watcher</h6>
      <p>systemd unit <code>burrow-watch.service</code>:
        <span class="badge" :class="unitClass" x-text="unitText"></span></p>
      <div class="grid">
        <label>Check every (s)<input type="number" min="10" max="86400" x-model="watchInterval"></label>
        <label>Alert after (checks)<input type="number" min="1" max="20" x-model="watchDebounce"></label>
      </div>
      <div class="row-buttons">
        <button :aria-busy="alertsBusy" :disabled="alertsBusy" @click="installWatch" x-text="installLabel"></button>
        <button class="danger outline" x-show="unitInstalled" :disabled="alertsBusy" @click="askUninstall">Uninstall</button>
      </div>
      <h6>Last seen by the watcher</h6>
      <p x-show="noWatchState"><small class="muted">Nothing yet. The watcher records a state per running project.</small></p>
      <table class="striped" x-show="hasWatchState">
        <thead><tr><th>Project</th><th>Status</th><th>Since</th><th>Pending</th></tr></thead>
        <tbody><template x-for="w in alertsData.watch" :key="w.project">
          <tr><td x-text="w.project"></td><td><span class="badge" :class="watchClass(w)" x-text="w.status"></span></td>
            <td x-text="watchSince(w)"></td><td><small x-text="watchPending(w)"></small></td></tr>
        </template></tbody>
      </table>
    </section>
    <section>
      <h6>Channels</h6>
      <p class="channel"><strong>Webhook</strong> <span class="badge" :class="chanClass('webhook')" x-text="webhookText"></span>
        <button type="button" x-show="canClear('webhook')" @click="clearChannel('webhook')" title="Remove">remove</button></p>
      <input type="password" x-model="newWebhook" placeholder="https://hooks.slack.com/services/…" aria-label="Webhook URL" autocomplete="off">
      <p class="channel"><strong>ntfy</strong> <span class="badge" :class="chanClass('ntfy')" x-text="ntfyText"></span>
        <button type="button" x-show="canClear('ntfy')" @click="clearChannel('ntfy')" title="Remove">remove</button></p>
      <input type="password" x-model="newNtfy" placeholder="topic or https://ntfy.example.dev/topic" aria-label="ntfy topic" autocomplete="off">
      <p class="channel"><strong>ntfy token</strong> <span class="badge" :class="chanClass('ntfyToken')" x-text="tokenText"></span>
        <button type="button" x-show="canClear('ntfyToken')" @click="clearChannel('ntfyToken')" title="Remove">remove</button></p>
      <input type="password" x-model="newNtfyToken" placeholder="optional access token" aria-label="ntfy token" autocomplete="off">
      <small class="muted">Saved to the burrow config file (mode 600). Values are never shown again. Settings from the
        environment win over the file.</small>
      <div class="row-buttons">
        <button :disabled="cannotSaveChannels" @click="saveChannels">Save</button>
        <button class="secondary outline" :disabled="noChannels" @click="testAlert">Send test alert</button>
      </div>
    </section>
  </div>
</article>
<dialog :open="uninstallOpen">
  <article>
    <header><strong>Uninstall burrow-watch.service?</strong></header>
    <p>This stops the watcher and removes its systemd unit. No more alerts are sent until you install it again.</p>
    <footer>
      <button class="secondary" @click="closeUninstall">Cancel</button>
      <button class="danger" @click="uninstallWatch">Uninstall</button>
    </footer>
  </article>
</dialog>`,
};

export const css = `
.alerts-grid{align-items:start}.alerts h6{margin:.5rem 0}
.alerts input{margin-bottom:.5rem}.alerts .channel{margin:.4rem 0 .2rem}
.alerts .channel button{all:unset;cursor:pointer;font-size:.8rem;color:var(--pico-del-color);margin-left:.4rem}
.alerts .channel button:hover{text-decoration:underline}
.row-buttons{display:flex;gap:.5rem;margin:.5rem 0 1rem}.row-buttons button{width:auto;margin:0}
`;

export const js = `
burrowPanel(function () {
  function empty() {
    return { channels: { webhook: {}, ntfy: {}, ntfyToken: {} }, service: { installed: false, active: 'unknown' }, watch: [] };
  }
  return {
    alertsOpen: false, alertsData: empty(), alertsError: '', alertsBusy: false, uninstallOpen: false,
    watchInterval: 60, watchDebounce: 2, newWebhook: '', newNtfy: '', newNtfyToken: '',

    get hasAlertsError() { return this.alertsError.length > 0; },
    get unitInstalled() { return this.alertsData.service.installed; },
    get unitText() { var s = this.alertsData.service; return s.installed ? s.active : 'not installed'; },
    get unitClass() { var s = this.alertsData.service; return !s.installed ? '' : s.active === 'active' ? 'ok' : 'bad'; },
    get installLabel() { return this.unitInstalled ? 'Reinstall with these settings' : 'Install and start'; },
    get hasWatchState() { return this.alertsData.watch.length > 0; },
    get noWatchState() { return this.alertsData.watch.length === 0; },
    get noChannels() { var c = this.alertsData.channels; return !c.webhook.set && !c.ntfy.set; },
    get cannotSaveChannels() { return this.alertsBusy || !(this.newWebhook || this.newNtfy || this.newNtfyToken); },
    get webhookText() { var c = this.alertsData.channels.webhook; return c.set ? c.kind + ' · ' + c.host + (c.fromEnv ? ' (env)' : '') : 'not set'; },
    get ntfyText() { var c = this.alertsData.channels.ntfy; return c.set ? c.server + (c.fromEnv ? ' (env)' : '') : 'not set'; },
    get tokenText() { var c = this.alertsData.channels.ntfyToken; return c.set ? 'set' + (c.fromEnv ? ' (env)' : '') : 'not set'; },
    chanClass: function (k) { return this.alertsData.channels[k].set ? 'ok' : ''; },
    canClear: function (k) { var c = this.alertsData.channels[k]; return c.set && !c.fromEnv; },
    watchClass: function (w) { return w.status === 'ok' ? 'ok' : w.status === 'down' ? 'bad' : 'warn'; },
    watchSince: function (w) { return w.since ? ago(Date.now() - w.since) + ' ago' : ''; },
    watchPending: function (w) { return w.pending ? w.pending + ' (' + w.count + ' check' + (w.count === 1 ? '' : 's') + ')' : ''; },

    openAlerts: function () { this.alertsOpen = true; this.loadAlerts(); },
    closeAlerts: function () { this.alertsOpen = false; },
    loadAlerts: async function () {
      this.alertsError = '';
      try { this.alertsData = await getJson('/api/alerts'); } catch (e) { this.alertsError = e.message; }
    },
    alertsPost: async function (url, body, okText) {
      this.alertsBusy = true; this.alertsError = '';
      try {
        var r = await post(url, body);
        if (r.status === 401) { location.assign('/login'); return null; }
        var j = await r.json().catch(function () { return {}; });
        if (j.channels) this.alertsData = { channels: j.channels, service: j.service, watch: j.watch };
        if (r.ok) this.showToast('✓ ' + okText + (j.output ? '\\n' + j.output : ''), true, 6000);
        else this.alertsError = j.error || (j.errors || []).join('; ') || j.output || ('HTTP ' + r.status);
        return r.ok ? j : null;
      } catch (e) { this.alertsError = 'Network error'; return null; } finally { this.alertsBusy = false; }
    },
    saveChannels: async function () {
      var body = {};
      if (this.newWebhook) body.webhook = this.newWebhook;
      if (this.newNtfy) body.ntfy = this.newNtfy;
      if (this.newNtfyToken) body.ntfyToken = this.newNtfyToken;
      if (await this.alertsPost('/api/alerts/config', body, 'Alert channels saved')) { this.newWebhook = ''; this.newNtfy = ''; this.newNtfyToken = ''; }
    },
    clearChannel: function (k) { var body = {}; body[k] = null; this.alertsPost('/api/alerts/config', body, 'Removed'); },
    testAlert: function () { this.alertsPost('/api/alerts/test', {}, 'Test alert sent'); },
    installWatch: function () {
      this.alertsPost('/api/alerts/service', { action: 'install', interval: Number(this.watchInterval), debounce: Number(this.watchDebounce) }, 'Watcher installed');
    },
    askUninstall: function () { this.uninstallOpen = true; },
    closeUninstall: function () { this.uninstallOpen = false; },
    uninstallWatch: function () { this.uninstallOpen = false; this.alertsPost('/api/alerts/service', { action: 'uninstall', confirm: true }, 'Watcher removed'); },
  };
});
`;
