// Panel: backup and restore. Download a `burrow export` bundle of every remembered project
// (tunnel.yml settings only: no tokens, passwords or hooks), and restore one: the server
// previews what each project would do first, and writing needs a typed confirmation.
// Restoring only writes tunnel.yml files and remembers them; nothing is started.
import YAML from 'yaml';
import { buildBundle, parseBundle, planImport, writeImported } from '../../transfer.js';
import { hostnames, parseProject } from '../../project.js';

export const order = 88;
export const CONFIRM_WORD = 'restore';
const MAX_BYTES = 1024 * 1024;

export function exportText(bundle = buildBundle()) {
  return '# burrow project export. Contains tunnel.yml settings only, no tokens or passwords.\n' + YAML.stringify(bundle, { lineWidth: 0 });
}

function preview(text, cfg) {
  const plan = planImport(parseBundle(text, 'The backup'));
  return plan.map((p) => ({
    project: p.project, status: p.status, dest: p.dest || null, knownAt: p.knownAt || null, error: p.error || null,
    services: p.proj ? p.proj.services.length : 0,
    hostnames: p.proj && cfg.domain ? hostnames(parseProject(YAML.stringify(p.proj)), cfg.domain).map((h) => h.hostname) : [],
  }));
}

export async function route(ctx) {
  const { method, path } = ctx;
  if (method === 'GET' && path === '/api/backup/export') {
    let text;
    try { text = exportText(); } catch (e) { return ctx.json(500, { error: e.message }) ?? true; }
    const name = `burrow-projects-${new Date().toISOString().slice(0, 10)}.yml`;
    ctx.log(`backup exported (requested from ${ctx.clientIp})`);
    ctx.send(200, text, 'application/yaml; charset=utf-8', { 'Content-Disposition': `attachment; filename="${name}"` });
    return true;
  }
  if (method !== 'POST' || !['/api/backup/preview', '/api/backup/restore'].includes(path)) return false;
  const body = await ctx.readJson(MAX_BYTES + 4096);
  if (!body || typeof body.text !== 'string') return ctx.json(400, { error: 'send the backup as { text }' }) ?? true;
  if (Buffer.byteLength(body.text) > MAX_BYTES) return ctx.json(413, { error: 'backup larger than 1 MB' }) ?? true;
  const cfg = ctx.loadConfig();
  let items;
  try { items = preview(body.text, cfg); } catch (e) { return ctx.json(400, { error: e.message }) ?? true; }
  if (path === '/api/backup/preview') return ctx.json(200, { projects: items }) ?? true;

  if (body.confirm !== CONFIRM_WORD) return ctx.json(400, { error: `type "${CONFIRM_WORD}" to confirm` }) ?? true;
  const pick = new Set(Array.isArray(body.projects) ? body.projects.filter((x) => typeof x === 'string') : []);
  if (!pick.size) return ctx.json(400, { error: 'nothing selected' }) ?? true;
  const replace = body.replace === true;
  const r = await ctx.withBusy('(backup)', async () => {
    // Planned again here, so the result matches the files as they are now.
    const plan = planImport(parseBundle(body.text, 'The backup'));
    const written = [];
    const skipped = [];
    for (const p of plan) {
      if (!pick.has(p.project)) continue;
      if (p.status === 'invalid') { skipped.push({ project: p.project, reason: p.error }); continue; }
      if (p.status !== 'new' && !replace) { skipped.push({ project: p.project, reason: p.status === 'known' ? `already remembered at ${p.knownAt}` : `${p.dest} exists` }); continue; }
      try { writeImported(p); written.push({ project: p.project, file: p.dest, replaced: p.status !== 'new' }); } catch (e) {
        skipped.push({ project: p.project, reason: e.message });
      }
    }
    ctx.log(`backup restored: ${written.length} written, ${skipped.length} skipped (requested from ${ctx.clientIp})`);
    ctx.events.emit('event', { action: 'restore', ok: true, detail: `${written.length} written, ${skipped.length} skipped` });
    ctx.invalidate();
    return { ok: true, written, skipped };
  });
  if (!r) return ctx.json(409, { error: 'a restore is already running' }) ?? true;
  ctx.json(200, r);
  return true;
}

export const html = {
  toolbar: '<li><button class="secondary outline" @click="openBackup">Backup</button></li>',
  sections: `
<article x-show="backupOpen" class="backup">
  <header class="logs-head">
    <strong>Backup and restore</strong><small class="muted">tunnel.yml settings only, no secrets</small>
    <span class="spacer"></span>
    <a class="secondary outline" role="button" href="/api/backup/export" download>Download backup</a>
    <button class="secondary outline" @click="closeBackup">Close</button>
  </header>
  <label>Restore from a backup file
    <input type="file" accept=".yml,.yaml,.json,application/yaml,application/json" @change="pickBackupFile" aria-label="Backup file">
  </label>
  <p class="error" x-show="hasBackupError" x-text="backupError"></p>
  <div x-show="hasRestorePlan">
    <table class="restore-plan">
      <thead><tr><th></th><th>Project</th><th>What happens</th><th>Hostnames</th></tr></thead>
      <tbody>
        <template x-for="p in restorePlan" :key="p.project">
          <tr>
            <td><input type="checkbox" :value="p.project" x-model="restorePick" :disabled="restoreDisabled(p)" :aria-label="p.project"></td>
            <td><strong x-text="p.project"></strong></td>
            <td><span class="badge" :class="restoreClass(p)" x-text="restoreText(p)"></span> <small class="muted" x-text="restoreDetail(p)"></small></td>
            <td><small x-text="restoreHosts(p)"></small></td>
          </tr>
        </template>
      </tbody>
    </table>
    <label><input type="checkbox" role="switch" x-model="restoreReplace"> Replace projects that already exist</label>
    <div class="row-buttons"><button class="danger" :disabled="nothingToRestore" @click="askRestore" x-text="restoreLabel"></button></div>
  </div>
</article>
<dialog :open="restoreConfirmOpen">
  <article>
    <header><strong>Restore from the backup?</strong></header>
    <p>This writes <strong x-text="restoreSummary"></strong> on the server and remembers them, so <strong>Up</strong> works.
      <span x-show="restoreReplace">Existing files of picked projects are <strong>overwritten</strong>.</span>
      Nothing is started. Type <strong>restore</strong> to confirm.</p>
    <input type="text" x-model="restoreConfirmText" placeholder="restore" aria-label="Type restore to confirm" autocomplete="off">
    <footer>
      <button class="secondary" @click="closeRestoreConfirm">Cancel</button>
      <button class="danger" :disabled="cannotRestore" :aria-busy="restoreBusy" @click="runRestore">Restore</button>
    </footer>
  </article>
</dialog>`,
};

export const css = `
.backup .restore-plan{font-size:.875rem;margin:.5rem 0}
.backup .row-buttons{display:flex;gap:.5rem;margin:.75rem 0}.backup .row-buttons button{width:auto;margin:0}
.backup a[role=button]{width:auto;margin:0;padding:.3rem .7rem;font-size:.85rem}
`;

export const js = `
burrowPanel(function () {
  var TEXT = { new: 'new', exists: 'file exists', known: 'already remembered', invalid: 'invalid' };
  var CLASS = { new: 'ok', exists: 'warn', known: 'warn', invalid: 'bad' };
  return {
    backupOpen: false, backupError: '', backupText: '', restorePlan: [], restorePick: [], restoreReplace: false,
    restoreConfirmOpen: false, restoreConfirmText: '', restoreBusy: false,
    get hasBackupError() { return this.backupError.length > 0; },
    get hasRestorePlan() { return this.restorePlan.length > 0; },
    get restoreCount() {
      var self = this;
      return this.restorePlan.filter(function (p) { return self.restorePick.indexOf(p.project) >= 0 && !self.restoreDisabled(p); }).length;
    },
    get restoreSummary() { return this.restoreCount + ' project file(s)'; },
    get restoreLabel() { return 'Restore ' + this.restoreSummary; },
    get nothingToRestore() { return this.restoreCount === 0; },
    get cannotRestore() { return this.restoreConfirmText !== 'restore' || this.restoreBusy; },
    restoreDisabled: function (p) { return p.status === 'invalid' || (p.status !== 'new' && !this.restoreReplace); },
    restoreText: function (p) { return p.status === 'new' ? 'new' : this.restoreReplace && p.status !== 'invalid' ? 'replace' : TEXT[p.status]; },
    restoreClass: function (p) { return p.status !== 'new' && p.status !== 'invalid' && this.restoreReplace ? 'bad' : CLASS[p.status]; },
    restoreDetail: function (p) { return p.error || (p.status === 'known' ? p.knownAt : p.dest) || ''; },
    restoreHosts: function (p) { return p.hostnames.join(', '); },
    openBackup: function () { this.backupOpen = true; },
    closeBackup: function () { this.backupOpen = false; },
    pickBackupFile: function (e) {
      var self = this;
      var f = e.target.files && e.target.files[0];
      this.backupError = ''; this.restorePlan = []; this.restorePick = [];
      if (!f) return;
      if (f.size > 1024 * 1024) { this.backupError = 'That file is larger than 1 MB.'; return; }
      var reader = new FileReader();
      reader.onload = function () { self.backupText = String(reader.result); self.previewRestore(); };
      reader.onerror = function () { self.backupError = 'Could not read the file.'; };
      reader.readAsText(f);
    },
    previewRestore: async function () {
      try {
        var r = await post('/api/backup/preview', { text: this.backupText });
        if (r.status === 401) { location.assign('/login'); return; }
        var j = await r.json().catch(function () { return {}; });
        if (!r.ok) { this.backupError = j.error || ('HTTP ' + r.status); return; }
        this.restorePlan = j.projects;
        this.restorePick = j.projects.filter(function (p) { return p.status === 'new'; }).map(function (p) { return p.project; });
      } catch (e) { this.backupError = 'Network error'; }
    },
    askRestore: function () { this.restoreConfirmText = ''; this.restoreConfirmOpen = true; },
    closeRestoreConfirm: function () { this.restoreConfirmOpen = false; },
    runRestore: async function () {
      if (this.cannotRestore) return;
      var self = this;
      var picks = this.restorePlan.filter(function (p) { return self.restorePick.indexOf(p.project) >= 0 && !self.restoreDisabled(p); }).map(function (p) { return p.project; });
      this.restoreBusy = true;
      try {
        var r = await post('/api/backup/restore', { text: this.backupText, projects: picks, replace: this.restoreReplace, confirm: 'restore' });
        if (r.status === 401) { location.assign('/login'); return; }
        var j = await r.json().catch(function () { return {}; });
        if (r.ok) {
          var lines = j.written.map(function (w) { return (w.replaced ? 'replaced ' : 'restored ') + w.project + ' -> ' + w.file; })
            .concat(j.skipped.map(function (s) { return 'skipped ' + s.project + ': ' + s.reason; }));
          this.showToast('✓ restore\\n' + lines.join('\\n'), true, 12000);
          this.restoreConfirmOpen = false;
          this.previewRestore();
          this.load();
        } else this.backupError = j.error || ('HTTP ' + r.status);
      } catch (e) { this.backupError = 'Network error'; } finally { this.restoreBusy = false; }
    },
  };
});
`;
