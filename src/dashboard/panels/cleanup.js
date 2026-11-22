// Panel: cleanup. Lists orphaned burrow-* tunnels and burrow:* DNS records with the
// same rules as `burrow prune`, and deletes the ones you pick after a typed confirmation.
// The orphan list is recomputed before deleting, so only things that are still orphans go.
// DNS records are looked up in every zone burrow knows (BURROW_DOMAIN's, zones of
// per-project `domain:` settings, cached and remembered), like `burrow prune`.
// DNS deletions queued by a destroy that couldn't read a zone are listed with a Retry button.
import { Cloudflare } from '../../cloudflare.js';
import { listPending, retryPending } from '../../pending.js';
import { findOrphans, localProjectNames } from '../../prune.js';
import { inZone, knownZones } from '../../zones.js';

export const order = 80;
export const CONFIRM_WORD = 'delete';

async function scan(cfg, includeActive) {
  if (!(cfg.token && cfg.accountId && cfg.domain)) throw Object.assign(new Error('Cloudflare not configured'), { status: 400 });
  const cf = new Cloudflare({ token: cfg.token, accountId: cfg.accountId, zoneId: cfg.zoneId });
  const tunnels = (await cf.listTunnels()).filter((t) => t.name.startsWith('burrow-'));
  // One unreadable zone (e.g. a stale cache entry for a domain removed from the account)
  // doesn't block the rest; it's reported so the page can say so.
  // Also when BURROW_DOMAIN's own zone can't be found: it's listed as not scanned.
  const zoneErrors = [];
  const zones = await knownZones(cf, cfg, { onError: (z, e) => zoneErrors.push({ zone: z.domain, error: e.message }) });
  const records = [];
  for (const z of zones) {
    try {
      for (const r of await inZone(cf, z.id).recordsByCommentPrefix('burrow:')) records.push({ ...r, zoneId: z.id, zoneName: z.domain });
    } catch (e) { zoneErrors.push({ zone: z.domain, error: e.message }); }
  }
  return { cf, zones, zoneErrors, ...findOrphans({ tunnels, records, local: localProjectNames(), includeActive }) };
}

const tunnelView = (t) => ({
  id: t.id, name: t.name, status: t.status || 'unknown', createdAt: t.created_at || null,
  connections: (t.connections || []).length,
});
const recordView = (r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, comment: r.comment, zone: r.zoneName });

const pendingView = (e) => ({ project: e.project, domain: e.domain, comment: e.comment, at: e.at, error: e.error });

export async function route(ctx) {
  if (ctx.path === '/api/cleanup/pending/retry' && ctx.method === 'POST') {
    const cfg = ctx.loadConfig();
    if (!(cfg.token && cfg.accountId && cfg.domain)) return ctx.json(400, { error: 'Cloudflare not configured' }) ?? true;
    const r = await ctx.withBusy('(cleanup)', async () => {
      const cf = new Cloudflare({ token: cfg.token, accountId: cfg.accountId, zoneId: cfg.zoneId });
      const res = await retryPending(cf);
      ctx.log(`cleanup: retried ${res.done.length + res.dropped.length + res.left.length} queued DNS cleanup(s), ${res.left.length} left (requested from ${ctx.clientIp})`);
      ctx.events.emit('event', { action: 'cleanup', ok: !res.left.length, detail: `retried queued DNS cleanups: ${res.done.length} done, ${res.left.length} left` });
      ctx.invalidate();
      return { ok: !res.left.length, output: res.lines.join('\n') || 'Nothing queued', pending: res.left.map(pendingView) };
    }).catch((e) => ({ ok: false, output: e.message, error: e.message }));
    if (!r) ctx.json(409, { error: 'a cleanup is already running' });
    else ctx.json(r.ok ? 200 : 502, r);
    return true;
  }
  if (ctx.path !== '/api/cleanup') return false;
  const cfg = ctx.loadConfig();
  if (ctx.method === 'GET') {
    try {
      const s = await scan(cfg, ctx.url.searchParams.get('includeActive') === '1');
      ctx.json(200, {
        tunnels: s.orphanTunnels.map(tunnelView), records: s.orphanRecords.map(recordView), skipped: s.skipped.map(tunnelView),
        zones: s.zones.map((z) => z.domain), zoneErrors: s.zoneErrors, pending: listPending().map(pendingView),
      });
    } catch (e) { ctx.json(e.status || 502, { error: e.message, pending: listPending().map(pendingView) }); }
    return true;
  }
  if (ctx.method !== 'POST') return false;
  const body = await ctx.readJson(64 * 1024);
  if (!body) return ctx.json(400, { error: 'invalid JSON' }) ?? true;
  if (body.confirm !== CONFIRM_WORD) return ctx.json(400, { error: `type "${CONFIRM_WORD}" to confirm` }) ?? true;
  const ids = (v) => new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 500) : []);
  const wantTunnels = ids(body.tunnelIds);
  const wantRecords = ids(body.recordIds);
  if (!wantTunnels.size && !wantRecords.size) return ctx.json(400, { error: 'nothing selected' }) ?? true;

  const r = await ctx.withBusy('(cleanup)', async () => {
    const s = await scan(cfg, body.includeActive === true);
    const tunnels = s.orphanTunnels.filter((t) => wantTunnels.has(t.id));
    // A record of a tunnel being deleted goes with it, as in `burrow prune`.
    const doomed = new Set(tunnels.map((t) => t.id));
    const records = s.orphanRecords.filter((x) => wantRecords.has(x.id) || [...doomed].some((id) => x.content === `${id}.cfargotunnel.com`));
    const lines = [];
    let failed = 0;
    for (const rec of records) {
      try { await inZone(s.cf, rec.zoneId).deleteRecord(rec.id); lines.push(`Deleted DNS ${rec.name}`); } catch (e) { failed++; lines.push(`Failed DNS ${rec.name}: ${e.message}`); }
    }
    for (const t of tunnels) {
      try {
        await s.cf.deleteTunnelConnections(t.id);
        await s.cf.deleteTunnel(t.id);
        lines.push(`Deleted tunnel ${t.name}`);
      } catch (e) { failed++; lines.push(`Failed tunnel ${t.name}: ${e.message}`); }
    }
    const notOrphans = [...wantTunnels].filter((id) => !s.orphanTunnels.some((t) => t.id === id)).length +
      [...wantRecords].filter((id) => !s.orphanRecords.some((x) => x.id === id)).length;
    if (notOrphans) lines.push(`Skipped ${notOrphans} item(s) that are no longer orphans`);
    for (const z of s.zoneErrors) lines.push(`Couldn't read DNS in ${z.zone}: ${z.error}`);
    ctx.log(`cleanup: deleted ${tunnels.length} tunnel(s), ${records.length} record(s) (requested from ${ctx.clientIp})`);
    ctx.events.emit('event', { action: 'cleanup', ok: !failed, detail: `${tunnels.length} tunnel(s), ${records.length} DNS record(s)` });
    ctx.invalidate();
    return { ok: !failed, output: lines.join('\n') || 'Nothing deleted', deleted: { tunnels: tunnels.length, records: records.length }, skipped: notOrphans };
  }).catch((e) => ({ ok: false, output: e.message, error: e.message }));
  if (!r) ctx.json(409, { error: 'a cleanup is already running' });
  else ctx.json(r.ok ? 200 : 500, r);
  return true;
}

export const html = {
  toolbar: '<li><button class="secondary outline" @click="openCleanup">Cleanup</button></li>',
  sections: `
<article x-show="cleanupOpen" class="cleanup">
  <header class="logs-head">
    <strong>Cleanup</strong><small class="muted">orphaned tunnels and DNS records</small>
    <span class="spacer"></span>
    <label><input type="checkbox" role="switch" x-model="cleanupActive" @change="scanCleanup"> Include tunnels with live connections</label>
    <button class="secondary outline" :aria-busy="cleanupLoading" @click="scanCleanup">Scan</button>
    <button class="secondary outline" @click="closeCleanup">Close</button>
  </header>
  <p class="error" x-show="hasCleanupError" x-text="cleanupError"></p>
  <p class="zones" x-show="hasZones"><small class="muted" x-text="zonesText"></small></p>
  <template x-for="z in cleanup.zoneErrors" :key="z.zone">
    <p class="zone-error"><small><span class="badge warn">not scanned</span> <code x-text="z.zone"></code> <span x-text="z.error"></span></small></p>
  </template>
  <div class="pending" x-show="hasPending">
    <h6>Queued DNS deletions</h6>
    <small class="muted">These projects were destroyed while a zone couldn't be read, so their DNS records there may still exist.</small>
    <template x-for="e in cleanup.pending" :key="pendingKey(e)">
      <p><small><span class="badge warn">pending</span> <code x-text="e.project"></code> in <code x-text="e.domain"></code> <span class="muted" x-text="e.error"></span></small></p>
    </template>
    <div class="row-buttons"><button class="secondary" :aria-busy="pendingBusy" :disabled="pendingBusy" @click="retryPending">Retry now</button></div>
  </div>
  <p x-show="cleanupClean"><span class="badge ok">clean</span> No orphaned burrow tunnels or DNS records.</p>
  <div x-show="hasOrphans">
    <h6>Tunnels</h6>
    <p x-show="noOrphanTunnels"><small class="muted">none</small></p>
    <template x-for="t in cleanup.tunnels" :key="t.id">
      <label class="orphan"><input type="checkbox" :value="t.id" x-model="pickTunnels">
        <code x-text="t.name"></code> <small class="muted" x-text="tunnelInfo(t)"></small></label>
    </template>
    <h6>DNS records</h6>
    <p x-show="noOrphanRecords"><small class="muted">none</small></p>
    <template x-for="r in cleanup.records" :key="r.id">
      <label class="orphan"><input type="checkbox" :value="r.id" x-model="pickRecords">
        <code x-text="r.name"></code> <small class="muted" x-text="recordInfo(r)"></small></label>
    </template>
    <div class="row-buttons"><button class="danger" :disabled="nothingPicked" @click="askCleanup" x-text="cleanupLabel"></button></div>
  </div>
  <div x-show="hasSkipped">
    <small class="muted">Not listed: tunnels with no local state but live connections (probably another machine):
      <span x-text="skippedNames"></span>. Switch on "Include tunnels with live connections" to clean them up too.</small>
  </div>
</article>
<dialog :open="cleanupConfirmOpen">
  <article>
    <header><strong>Delete from Cloudflare?</strong></header>
    <p>This deletes <strong x-text="pickSummary"></strong> from Cloudflare. It can't be undone.
      Type <strong>delete</strong> to confirm.</p>
    <input type="text" x-model="cleanupConfirmText" placeholder="delete" aria-label="Type delete to confirm" autocomplete="off">
    <footer>
      <button class="secondary" @click="closeCleanupConfirm">Cancel</button>
      <button class="danger" :disabled="cannotCleanup" :aria-busy="cleanupBusy" @click="runCleanup">Delete</button>
    </footer>
  </article>
</dialog>`,
};

export const css = `
.cleanup .zones,.cleanup .zone-error,.cleanup .pending p{margin:.25rem 0}
.cleanup h6{margin:.75rem 0 .35rem}.cleanup label.orphan{display:block;margin:.2rem 0}
.cleanup .row-buttons{display:flex;gap:.5rem;margin:.75rem 0}.cleanup .row-buttons button{width:auto;margin:0}
`;

export const js = `
burrowPanel(function () {
  function none() { return { tunnels: [], records: [], skipped: [], zones: [], zoneErrors: [], pending: [] }; }
  return {
    cleanupOpen: false, cleanup: none(), cleanupLoaded: false, cleanupLoading: false, cleanupError: '', cleanupActive: false,
    pickTunnels: [], pickRecords: [], cleanupConfirmOpen: false, cleanupConfirmText: '', cleanupBusy: false, pendingBusy: false,
    get hasPending() { return (this.cleanup.pending || []).length > 0; },
    pendingKey: function (e) { return e.comment + ' ' + e.domain; },

    get hasCleanupError() { return this.cleanupError.length > 0; },
    get hasZones() { return (this.cleanup.zones || []).length > 0; },
    get zonesText() { var z = this.cleanup.zones || []; return 'DNS checked in ' + z.length + (z.length === 1 ? ' zone: ' : ' zones: ') + z.join(', '); },
    get hasOrphans() { return this.cleanup.tunnels.length + this.cleanup.records.length > 0; },
    get cleanupClean() { return this.cleanupLoaded && !this.cleanupError && !this.hasOrphans && !this.hasPending; },
    get noOrphanTunnels() { return this.cleanup.tunnels.length === 0; },
    get noOrphanRecords() { return this.cleanup.records.length === 0; },
    get hasSkipped() { return this.cleanup.skipped.length > 0 && !this.cleanupActive; },
    get skippedNames() { return this.cleanup.skipped.map(function (t) { return t.name; }).join(', '); },
    get nothingPicked() { return this.pickTunnels.length + this.pickRecords.length === 0; },
    get pickSummary() { return this.pickTunnels.length + ' tunnel(s) and ' + this.pickRecords.length + ' DNS record(s)'; },
    get cleanupLabel() { return 'Delete ' + this.pickSummary; },
    get cannotCleanup() { return this.cleanupConfirmText !== 'delete' || this.cleanupBusy; },
    tunnelInfo: function (t) { return t.status + (t.connections ? ' · ' + t.connections + ' live conn' : '') + (t.createdAt ? ' · created ' + t.createdAt.slice(0, 10) : ''); },
    recordInfo: function (r) { return r.type + ' → ' + r.content + ' (' + r.comment + (r.zone ? ', zone ' + r.zone : '') + ')'; },

    openCleanup: function () { this.cleanupOpen = true; this.scanCleanup(); },
    closeCleanup: function () { this.cleanupOpen = false; },
    scanCleanup: async function () {
      this.cleanupLoading = true; this.cleanupError = '';
      try {
        this.cleanup = Object.assign(none(), await getJson('/api/cleanup' + (this.cleanupActive ? '?includeActive=1' : '')));
        this.pickTunnels = this.cleanup.tunnels.map(function (t) { return t.id; });
        this.pickRecords = this.cleanup.records.map(function (r) { return r.id; });
      } catch (e) { this.cleanup = none(); this.cleanupError = e.message; } finally { this.cleanupLoading = false; this.cleanupLoaded = true; }
    },
    retryPending: async function () {
      this.pendingBusy = true;
      try {
        var r = await post('/api/cleanup/pending/retry', {});
        if (r.status === 401) { location.assign('/login'); return; }
        var j = await r.json().catch(function () { return {}; });
        this.showToast((j.ok ? '✓ queued DNS cleanup\\n' : '✗ queued DNS cleanup\\n') + (j.output || j.error || ''), !!j.ok, 12000);
      } catch (e) { this.showToast('✗ queued DNS cleanup: network error', false); } finally {
        this.pendingBusy = false; this.scanCleanup(); this.load();
      }
    },
    askCleanup: function () { this.cleanupConfirmText = ''; this.cleanupConfirmOpen = true; },
    closeCleanupConfirm: function () { this.cleanupConfirmOpen = false; },
    runCleanup: async function () {
      if (this.cannotCleanup) return;
      this.cleanupBusy = true;
      try {
        var r = await post('/api/cleanup', { confirm: 'delete', tunnelIds: this.pickTunnels, recordIds: this.pickRecords, includeActive: this.cleanupActive });
        if (r.status === 401) { location.assign('/login'); return; }
        var j = await r.json().catch(function () { return {}; });
        this.showToast((j.ok ? '✓ cleanup\\n' : '✗ cleanup\\n') + (j.output || j.error || ''), !!j.ok, 12000);
      } catch (e) { this.showToast('✗ cleanup: network error', false); } finally {
        this.cleanupBusy = false; this.cleanupConfirmOpen = false; this.scanCleanup(); this.load();
      }
    },
  };
});
`;
