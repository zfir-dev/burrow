// Panel: update notice. Runs `burrow update --check --json` (git checkout: git fetch;
// global npm install: git ls-remote on the install source) at most once a day, only when
// someone has the dashboard open, and caches the result in the state dir. The page shows
// the version and, when something newer exists, an "Update available" notice with the new
// commits. Installing stays a terminal step (`burrow update`). BURROW_UPDATE_CHECK=off
// turns the check off.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from '../../config.js';
import { detectInstall } from '../../update.js';

export const order = 95;
export const cacheFile = () => join(stateDir(), 'cache', 'update.json');
const maxAgeMs = () => (Number(process.env.BURROW_UPDATE_CHECK_HOURS) > 0 ? Number(process.env.BURROW_UPDATE_CHECK_HOURS) : 24) * 3600e3;
export const checksEnabled = (env = process.env) => !/^(off|0|false|no)$/i.test(env.BURROW_UPDATE_CHECK || '');

function readCache() { try { return JSON.parse(readFileSync(cacheFile(), 'utf8')); } catch { return null; } }
function writeCache(c) {
  mkdirSync(dirname(cacheFile()), { recursive: true, mode: 0o700 });
  writeFileSync(cacheFile(), JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
}
// Errors may quote a remote URL; drop any credentials in it.
export const scrub = (s) => String(s || '').replace(/\/\/[^/\s@]+@/g, '//').slice(0, 300);

// The JSON line `update --check --json` printed, or null.
export function parseCheck(output) {
  for (const line of String(output || '').split('\n').reverse()) {
    if (!line.startsWith('{')) continue;
    try { const j = JSON.parse(line); if ('available' in j) return j; } catch {}
  }
  return null;
}

let inflight = null;
async function runCheck(ctx) {
  if (inflight) return inflight;
  inflight = (async () => {
    const r = await ctx.runCli(['update', '--check', '--json'], 90000);
    const result = r.ok ? parseCheck(r.output) : null;
    const entry = result
      ? { checkedAt: Date.now(), result, error: null }
      : { checkedAt: Date.now(), result: readCache()?.result || null, error: scrub(r.output.trim().split('\n').pop() || 'check failed') };
    writeCache(entry);
    if (result?.available) ctx.log(`update available: ${result.version} ${result.head || ''} -> ${result.remoteVersion || ''} ${result.latest || ''}`.trim());
    return entry;
  })().finally(() => { inflight = null; });
  return inflight;
}

function localVersion() {
  try { const i = detectInstall(); return { version: i.pkg.version, mode: i.mode }; } catch { return { version: null, mode: 'unknown' }; }
}

export async function route(ctx) {
  if (ctx.path !== '/api/update' && ctx.path !== '/api/update/check') return false;
  const local = localVersion();
  if (!checksEnabled()) return ctx.json(200, { enabled: false, ...local }) ?? true;
  if (ctx.method === 'GET' && ctx.path === '/api/update') {
    const c = readCache();
    const stale = !c || Date.now() - c.checkedAt > maxAgeMs();
    if (stale && !inflight) runCheck(ctx).catch((e) => ctx.log(`error: update check: ${e.message}`));
    return ctx.json(200, { enabled: true, ...local, checking: !!inflight, ...(c || { checkedAt: null, result: null, error: null }) }) ?? true;
  }
  if (ctx.method === 'POST' && ctx.path === '/api/update/check') {
    const entry = await ctx.withBusy('(update)', () => runCheck(ctx));
    if (!entry) return ctx.json(409, { error: 'already checking' }) ?? true;
    return ctx.json(200, { enabled: true, ...local, checking: false, ...entry }) ?? true;
  }
  return false;
}

export const html = {
  toolbar: '<li x-show="updateAvailable"><button class="update-notice" @click="openUpdate">Update available</button></li>',
  sections: `
<p class="version-line"><small class="muted">
  <span x-text="versionText"></span>
  <a href="#" x-show="updateEnabled" @click.prevent="checkUpdate" :aria-busy="updateChecking">Check for updates</a>
</small></p>`,
  dialogs: `
<dialog :open="updateOpen">
  <article>
    <header><strong>burrow update available</strong></header>
    <p x-text="updateSummary"></p>
    <ul x-show="hasUpdateCommits"><template x-for="c in updateCommits" :key="c"><li><code x-text="c"></code></li></template></ul>
    <p>Install it from a terminal on this machine, then restart the dashboard:</p>
    <pre><code>burrow update
burrow dashboard up</code></pre>
    <footer>
      <button class="secondary" @click="dismissUpdate">Remind me later</button>
      <button @click="closeUpdate">Close</button>
    </footer>
  </article>
</dialog>`,
};

export const css = `
.version-line{margin:.75rem 0 0;text-align:right}.version-line a{margin-left:.5rem}
.update-notice{padding:.35rem .8rem;background:#d97706;border-color:#d97706;color:#fff}
`;

export const js = `
burrowPanel(function () {
  var DISMISS = 'burrow.update.dismissed';
  return {
    update: null, updateOpen: false, updateChecking: false, updateDismissed: '',
    get updateEnabled() { return !!(this.update && this.update.enabled); },
    get updateResult() { return this.update && this.update.result ? this.update.result : null; },
    get updateAvailable() { var r = this.updateResult; return !!(r && r.available && this.updateDismissed !== r.latest); },
    get updateCommits() { return this.updateResult && this.updateResult.commits ? this.updateResult.commits : []; },
    get hasUpdateCommits() { return this.updateCommits.length > 0; },
    get updateSummary() {
      var r = this.updateResult;
      if (!r) return '';
      var to = r.remoteVersion && r.remoteVersion !== r.version ? r.remoteVersion : r.latest;
      return 'burrow ' + r.version + ' → ' + to + (r.behind ? ' (' + r.behind + ' new commit' + (r.behind === 1 ? '' : 's') + ')' : '') + '.';
    },
    get versionText() {
      var u = this.update;
      if (!u) return '';
      var t = 'burrow ' + (u.version || '?');
      if (!u.enabled) return t + ' · update checks off';
      if (u.checking || this.updateChecking) return t + ' · checking for updates…';
      if (u.error) return t + ' · update check failed: ' + u.error;
      if (!u.result) return t;
      var when = u.checkedAt ? ' (checked ' + ago(Date.now() - u.checkedAt) + ' ago)' : '';
      return t + (u.result.available ? ' · update available' : u.result.available === false ? ' · up to date' : '') + when;
    },
    init: function () {
      try { this.updateDismissed = localStorage.getItem(DISMISS) || ''; } catch (e) {}
      this.loadUpdate();
    },
    loadUpdate: async function () {
      try {
        this.update = await getJson('/api/update');
        var self = this;
        if (this.update.checking) setTimeout(function () { self.loadUpdate(); }, 5000);
      } catch (e) {}
    },
    checkUpdate: async function () {
      this.updateChecking = true;
      try {
        var r = await post('/api/update/check', {});
        var j = await r.json().catch(function () { return {}; });
        if (r.ok) this.update = j; else this.showToast('✗ ' + (j.error || 'HTTP ' + r.status), false);
      } catch (e) { this.showToast('✗ update check failed', false); } finally { this.updateChecking = false; }
    },
    openUpdate: function () { this.updateOpen = true; },
    closeUpdate: function () { this.updateOpen = false; },
    dismissUpdate: function () {
      var r = this.updateResult;
      if (r) { this.updateDismissed = r.latest; try { localStorage.setItem(DISMISS, r.latest); } catch (e) {} }
      this.updateOpen = false;
    },
  };
});
`;
