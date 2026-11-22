// Panel: shares. Start a temporary `burrow share` link (detached) for a local port or URL,
// with an expiry, list the shares this machine has, extend them, or stop them (which deletes
// the hostname, tunnel and DNS record, like `burrow down share-<name>`). Expired shares are
// stopped by the dashboard; one that expired while it was off is stopped when it starts.
// Shares started in a terminal (`burrow share`, also with --expires) are listed too: the state
// file is shared, so extending one changes the expiry that process checks, and stopping one
// asks that process to remove it (it checks every 2 s); if it's gone, `burrow down` does it.
import { readdirSync } from 'node:fs';
import { assertLabel } from '../../naming.js';
import { loadConfig, stateDir } from '../../config.js';
import { readMeta, runningPid, saveMeta } from '../../process.js';
import { SHARE_PREFIX, isShare, randomLabel, targetUrl, ownerAlive, requestStop } from '../../share.js';
import { runCli } from '../server.js';

export const order = 35;
export const EXPIRY_MINUTES = [15, 60, 240, 1440, 10080]; // 15 min … 7 days; 0 = never
const SWEEP_MS = 30 * 1000;
const HANDOFF_MS = Number(process.env.BURROW_SHARE_HANDOFF_MS) || 10 * 1000;

// Stop one share. A terminal-owned share is asked to stop itself (so its Ctrl+C cleanup and
// event history run there); if that process doesn't finish in time, or is gone, `burrow down`.
export async function stopShare(project, { run = runCli, wait = HANDOFF_MS } = {}) {
  const meta = readMeta(project);
  if (!meta) return { ok: true, output: `${project} is already gone` };
  if (ownerAlive(meta)) {
    requestStop(project);
    const until = Date.now() + wait;
    while (Date.now() < until) {
      if (!readMeta(project)) return { ok: true, output: `Asked the terminal "burrow share" (pid ${meta.ownerPid}) to stop; it removed ${meta.hostname}.` };
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!readMeta(project)) return { ok: true, output: `Removed ${meta.hostname}` };
  }
  return run(['down', project]);
}

export function listShares(now = Date.now()) {
  let names = [];
  try { names = readdirSync(stateDir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch {}
  return names.filter((n) => n.startsWith(SHARE_PREFIX) && isShare(n)).sort().map((project) => {
    const m = readMeta(project);
    const expiresAt = m.expiresAt || null;
    return {
      project, label: project.slice(SHARE_PREFIX.length), hostname: m.hostname, target: m.target,
      createdAt: m.createdAt || null, expiresAt, expired: !!expiresAt && Date.parse(expiresAt) <= now,
      running: !!runningPid(project), foreground: ownerAlive(m),
    };
  });
}

const expiryFrom = (minutes, now = Date.now()) => (minutes ? new Date(now + minutes * 60000).toISOString() : null);
function parseExpiry(v) {
  const n = Number(v);
  if (n === 0 || EXPIRY_MINUTES.includes(n)) return n;
  throw new Error(`expiresIn must be one of 0 (never), ${EXPIRY_MINUTES.join(', ')} (minutes)`);
}

// Stop every expired share. `run` is runCli (injectable for tests).
const sweeping = new Set();
export async function sweepExpired({ now = Date.now(), run = runCli, onStopped = () => {} } = {}) {
  const stopped = [];
  for (const s of listShares(now)) {
    // A terminal-owned share stops itself at its expiry; this only catches the rest.
    if (!s.expired || sweeping.has(s.project)) continue;
    sweeping.add(s.project);
    try {
      const r = await stopShare(s.project, { run });
      stopped.push({ project: s.project, ok: r.ok });
      onStopped(s, r);
    } finally { sweeping.delete(s.project); }
  }
  return stopped;
}

let sweeper = null;
function startSweeper(ctx) {
  if (sweeper) return;
  const tick = () => sweepExpired({
    onStopped: (s, r) => {
      ctx.log(`share ${s.project} expired; stopped (${r.ok ? 'ok' : 'failed'})`);
      ctx.events.emit('event', { action: 'share expired', project: s.project, ok: r.ok, detail: s.hostname });
      ctx.invalidate();
    },
  }).catch(() => {});
  sweeper = setInterval(tick, SWEEP_MS);
  sweeper.unref?.();
  setTimeout(tick, 2000).unref?.();
}

export async function enrich(projects, ctx) {
  startSweeper(ctx);
  for (const p of projects) {
    if (!p.project.startsWith(SHARE_PREFIX)) continue;
    const m = readMeta(p.project);
    if (m?.share) p.shareExpiresAt = m.expiresAt || null;
  }
}

export async function route(ctx) {
  const { method, path } = ctx;
  if (!path.startsWith('/api/shares')) return false;
  startSweeper(ctx);
  if (method === 'GET' && path === '/api/shares') {
    return ctx.json(200, { shares: listShares(), domain: loadConfig().domain || null, expiry: EXPIRY_MINUTES }) ?? true;
  }
  if (method !== 'POST') return false;
  const body = await ctx.readJson();
  if (!body) return ctx.json(400, { error: 'invalid JSON' }) ?? true;

  if (path === '/api/shares') {
    let url; let label; let minutes;
    try {
      url = targetUrl(body.target);
      label = String(body.name || '').trim() || randomLabel();
      assertLabel(label, 'share name');
      minutes = parseExpiry(body.expiresIn ?? 60);
      if (readMeta(SHARE_PREFIX + label)) throw new Error(`a share called ${label} already exists`);
    } catch (e) { return ctx.json(400, { error: e.message }) ?? true; }
    const project = SHARE_PREFIX + label;
    const r = await ctx.withBusy(project, async () => {
      ctx.log(`share ${url} as ${label} for ${minutes || 'no'} minute(s) (requested from ${ctx.clientIp})`);
      const run = await ctx.runCli(['share', url, '--name', label, '--detach']);
      const meta = readMeta(project);
      if (run.ok && meta) saveMeta(project, { ...meta, expiresAt: expiryFrom(minutes) });
      ctx.invalidate();
      return { ok: run.ok && !!meta, output: run.output, share: listShares().find((s) => s.project === project) || null };
    });
    if (!r) return ctx.json(409, { error: `${project} is busy` }) ?? true;
    return ctx.json(r.ok ? 200 : 500, r) ?? true;
  }

  const m = path.match(/^\/api\/shares\/([^/]+)\/(stop|extend)$/);
  if (!m) return false;
  const [, project, action] = m;
  try { assertLabel(project, 'share'); } catch { return ctx.json(400, { error: 'bad share' }) ?? true; }
  if (!project.startsWith(SHARE_PREFIX) || !isShare(project)) return ctx.json(404, { error: `${project} is not a share` }) ?? true;
  const meta = readMeta(project);
  if (action === 'extend') {
    let minutes;
    try { minutes = parseExpiry(body.expiresIn); } catch (e) { return ctx.json(400, { error: e.message }) ?? true; }
    saveMeta(project, { ...meta, expiresAt: expiryFrom(minutes) });
    return ctx.json(200, { ok: true, share: listShares().find((s) => s.project === project) }) ?? true;
  }
  if (body.confirm !== true) return ctx.json(400, { error: 'confirm stopping the share (confirm: true)' }) ?? true;
  const r = await ctx.withBusy(project, async () => {
    ctx.log(`stop share ${project} (requested from ${ctx.clientIp})`);
    const run = await stopShare(project, { run: ctx.runCli });
    ctx.invalidate();
    return run;
  });
  if (!r) return ctx.json(409, { error: `${project} is busy` }) ?? true;
  ctx.json(r.ok ? 200 : 500, r);
  return true;
}

export const html = {
  toolbar: '<li><button class="secondary outline" @click="openShares">Shares</button></li>',
  sections: `
<article x-show="sharesOpen" class="shares">
  <header class="logs-head">
    <strong>Shares</strong><small class="muted">temporary links to a local port or URL</small>
    <span class="spacer"></span>
    <button class="secondary outline" @click="closeShares">Close</button>
  </header>
  <form class="share-form" @submit.prevent="startShare">
    <input type="text" x-model="shareTarget" placeholder="Port or URL, e.g. 3000" aria-label="Port or URL to share" autocomplete="off" required>
    <input type="text" x-model="shareName" placeholder="Name (optional)" aria-label="Share name" autocomplete="off">
    <select x-model="shareExpiry" aria-label="Expires after">
      <option value="15">15 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option>
      <option value="1440">1 day</option><option value="10080">7 days</option><option value="0">Never</option>
    </select>
    <button type="submit" :aria-busy="shareBusy" :disabled="shareBusy">Share</button>
  </form>
  <small class="muted" x-text="shareHostHint"></small>
  <p class="error" x-show="hasShareError" x-text="shareError"></p>
  <p x-show="noShares"><small class="muted">No shares.</small></p>
  <table x-show="hasShares" class="share-list">
    <thead><tr><th>Link</th><th>To</th><th>Expires</th><th></th></tr></thead>
    <tbody>
      <template x-for="s in shares" :key="s.project">
        <tr>
          <td><a :href="shareUrl(s)" target="_blank" rel="noopener noreferrer" x-text="s.hostname"></a> <span class="badge" :class="shareStateClass(s)" x-text="shareState(s)"></span></td>
          <td><code x-text="s.target"></code></td>
          <td><small x-text="shareExpires(s)"></small></td>
          <td><div class="actions">
            <button class="secondary outline" @click="extendShare(s)">+1 hour</button>
            <button class="danger outline" :title="shareStopTitle(s)" @click="askStopShare(s)">Stop</button>
          </div></td>
        </tr>
      </template>
    </tbody>
  </table>
</article>
<dialog :open="shareStopOpen">
  <article>
    <header><strong>Stop sharing <span x-text="shareStopHost"></span>?</strong></header>
    <p>The link stops working right away: cloudflared is stopped and the share's tunnel and DNS record are deleted.</p>
    <footer>
      <button class="secondary" @click="closeStopShare">Cancel</button>
      <button class="danger" :aria-busy="shareBusy" :disabled="shareBusy" @click="stopShare">Stop sharing</button>
    </footer>
  </article>
</dialog>`,
};

export const css = `
.share-form{display:grid;grid-template-columns:2fr 1.5fr 1fr auto;gap:.5rem;align-items:start;margin:.5rem 0 .2rem}
.share-form input,.share-form select,.share-form button{margin:0}
.share-list{font-size:.875rem;margin-top:.6rem}
@media (max-width:700px){.share-form{grid-template-columns:1fr}}
`;

export const js = `
burrowPanel(function () {
  return {
    sharesOpen: false, shares: [], sharesLoaded: false, shareDomain: '', shareTarget: '', shareName: '', shareExpiry: '60',
    shareBusy: false, shareError: '', shareStopOpen: false, shareStopping: null, sharesTimer: null,
    get hasShares() { return this.shares.length > 0; },
    get noShares() { return this.sharesLoaded && this.shares.length === 0; },
    get hasShareError() { return this.shareError.length > 0; },
    get shareStopHost() { return this.shareStopping ? this.shareStopping.hostname : ''; },
    get shareHostHint() { return this.shareDomain ? 'Link: https://' + (this.shareName.trim() || '<random>') + '.' + this.shareDomain : ''; },
    shareUrl: function (s) { return 'https://' + s.hostname; },
    shareState: function (s) { return s.running ? (s.foreground ? 'terminal' : 'live') : 'stopped'; },
    shareStateClass: function (s) { return s.running ? 'ok' : 'bad'; },
    shareStopTitle: function (s) { return s.foreground ? 'Started with "burrow share" in a terminal: that process is asked to stop and remove it' : ''; },
    shareExpires: function (s) {
      if (!s.expiresAt) return s.foreground ? 'when the terminal stops' : 'never';
      var left = Date.parse(s.expiresAt) - Date.now();
      return left > 0 ? 'in ' + ago(left) : 'now';
    },
    openShares: function () {
      var self = this;
      this.sharesOpen = true; this.loadShares();
      clearInterval(this.sharesTimer);
      this.sharesTimer = setInterval(function () { if (self.sharesOpen) self.loadShares(); }, 15000);
    },
    closeShares: function () { this.sharesOpen = false; clearInterval(this.sharesTimer); },
    loadShares: async function () {
      try { var j = await getJson('/api/shares'); this.shares = j.shares; this.shareDomain = j.domain || ''; this.sharesLoaded = true; }
      catch (e) { this.shareError = e.message; }
    },
    sharePost: async function (url, body) {
      var r = await post(url, body);
      if (r.status === 401) { location.assign('/login'); throw new Error('login required'); }
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(j.error || (j.output ? j.output.trim().split('\\n').pop() : 'HTTP ' + r.status));
      return j;
    },
    startShare: async function () {
      this.shareBusy = true; this.shareError = '';
      try {
        var j = await this.sharePost('/api/shares', { target: this.shareTarget, name: this.shareName.trim(), expiresIn: Number(this.shareExpiry) });
        this.showToast('✓ sharing ' + (j.share ? 'https://' + j.share.hostname : ''), true, 8000);
        this.shareTarget = ''; this.shareName = '';
        this.loadShares(); this.load();
      } catch (e) { this.shareError = e.message; } finally { this.shareBusy = false; }
    },
    extendShare: async function (s) {
      try { await this.sharePost('/api/shares/' + encodeURIComponent(s.project) + '/extend', { expiresIn: 60 }); this.loadShares(); }
      catch (e) { this.shareError = e.message; }
    },
    askStopShare: function (s) { this.shareStopping = s; this.shareStopOpen = true; },
    closeStopShare: function () { this.shareStopOpen = false; },
    stopShare: async function () {
      var s = this.shareStopping;
      if (!s) return;
      this.shareBusy = true;
      try {
        await this.sharePost('/api/shares/' + encodeURIComponent(s.project) + '/stop', { confirm: true });
        this.showToast('✓ stopped ' + s.hostname, true, 5000);
      } catch (e) { this.shareError = e.message; } finally {
        this.shareBusy = false; this.shareStopOpen = false; this.loadShares(); this.load();
      }
    },
  };
});
`;
