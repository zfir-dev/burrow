// Panel: add or edit a project from the dashboard. Writes a validated tunnel.yml and
// can run `burrow up` right after. File paths never come from the browser: new files
// go where `burrow import` puts them, edits go to the file `burrow up` remembered.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { stateDir } from '../../config.js';
import { join } from 'node:path';
import { assertLabel, tunnelName } from '../../naming.js';
import { parseProject, hostnames, DASHBOARD_PROJECT } from '../../project.js';
import { readMeta, runningPid, saveMeta } from '../../process.js';
import { isShare } from '../../share.js';
import { defaultImportDir } from '../../transfer.js';
import { Cloudflare } from '../../cloudflare.js';
import { formFromText, renderNew, renderEdit, renameText } from '../../project-form.js';
import { projectDomain, readZoneCache } from '../../zones.js';

export const order = 10;

// The remembered tunnel.yml of a project the form may edit, or null.
export function editableFile(project) {
  if (project === DASHBOARD_PROJECT || isShare(project)) return null;
  const file = readMeta(project)?.file;
  return file && existsSync(file) ? file : null;
}

export const newProjectFile = (project) => join(defaultImportDir(), `${project}.tunnel.yml`);

// Hostnames on the project's own domain (`domain:`), else BURROW_DOMAIN.
const hostsOn = (proj, cfg) => {
  const domain = projectDomain(proj, cfg);
  return domain ? hostnames(proj, domain).map((h) => h.hostname) : [];
};
function preview(text, cfg) {
  const proj = parseProject(text);
  return { yaml: text, domain: projectDomain(proj, cfg) || null, hostnames: hostsOn(proj, cfg) };
}

// Domains the form offers: Cloudflare zones on the account (cached for 5 minutes), the
// zone cache, and domains remembered projects use. BURROW_DOMAIN is the default choice.
let zoneList = { at: 0, key: '', names: [], error: null };
const ZONE_LIST_TTL = 5 * 60 * 1000;
async function accountZones(cfg) {
  const key = `${cfg.accountId}`;
  if (zoneList.key === key && Date.now() - zoneList.at < ZONE_LIST_TTL) return zoneList;
  try {
    const cf = new Cloudflare({ token: cfg.token, accountId: cfg.accountId, zoneId: cfg.zoneId });
    const zones = await cf.all('/zones', { 'account.id': cfg.accountId });
    const names = zones.filter((z) => !z.account?.id || z.account.id === cfg.accountId)
      .map((z) => ({ name: z.name, status: z.status || 'active' }));
    zoneList = { at: Date.now(), key, names, error: null };
  } catch (e) { zoneList = { at: Date.now(), key, names: [], error: e.message }; }
  return zoneList;
}
export async function domainChoices(cfg) {
  const out = new Map();
  const add = (name, source, status) => {
    if (!name || name === cfg.domain) return;
    const d = out.get(name) || { name, sources: [], status: null };
    if (!d.sources.includes(source)) d.sources.push(source);
    if (status) d.status = status;
    out.set(name, d);
  };
  let error = null;
  if (cfg.token && cfg.accountId) {
    const z = await accountZones(cfg);
    error = z.error;
    for (const x of z.names) add(x.name, 'cloudflare', x.status);
  } else error = 'Cloudflare not configured';
  for (const [name, z] of Object.entries(readZoneCache())) if (z.accountId === cfg.accountId) add(name, 'cached');
  for (const p of rememberedProjects()) {
    const file = editableFile(p);
    if (!file) continue;
    try { const proj = parseProject(readFileSync(file, 'utf8'), file); if (proj.domain) add(proj.domain, 'in use'); } catch {}
  }
  return { default: cfg.domain || null, domains: [...out.values()].sort((a, b) => a.name.localeCompare(b.name)), error };
}
function rememberedProjects() {
  try { return readdirSync(stateDir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; }
}

export async function enrich(projects) {
  for (const p of projects) p.editable = !p.builtIn && !!editableFile(p.project);
}

export async function route(ctx) {
  const { method, path } = ctx;
  if (method === 'GET' && path === '/api/domains') return ctx.json(200, await domainChoices(ctx.loadConfig())) ?? true;
  const rm = path.match(/^\/api\/projects\/([^/]+)\/rename$/);
  if (rm && method === 'POST') return rename(ctx, rm[1]);
  let m = path.match(/^\/api\/projects\/([^/]+)\/config$/);
  if (m) {
    const project = m[1];
    try { assertLabel(project, 'project'); } catch { return ctx.json(400, { error: 'bad project' }) ?? true; }
    const file = editableFile(project);
    if (!file) return ctx.json(404, { error: `${project} has no remembered tunnel.yml to edit` }) ?? true;
    if (method === 'GET') {
      try { ctx.json(200, { file, form: formFromText(readFileSync(file, 'utf8'), file) }); } catch (e) {
        ctx.json(422, { error: `${file} is not valid: ${e.message}. Fix it with "burrow edit ${project}".` });
      }
      return true;
    }
    if (method !== 'POST') return false;
    const body = await ctx.readJson();
    if (!body) return ctx.json(400, { error: 'invalid JSON' }) ?? true;
    let text;
    try {
      text = renderEdit(readFileSync(file, 'utf8'), { ...body.form, project }, file);
    } catch (e) { return ctx.json(400, { error: e.message }) ?? true; }
    return save(ctx, { project, file, text, up: body.up === true, action: 'edit' });
  }

  if (method === 'POST' && path === '/api/projects/check') {
    const body = await ctx.readJson();
    if (!body) return ctx.json(400, { error: 'invalid JSON' }) ?? true;
    try {
      let text;
      if (body.editing) {
        const file = editableFile(String(body.form?.project || ''));
        if (!file) throw new Error('this project has no remembered tunnel.yml');
        text = renderEdit(readFileSync(file, 'utf8'), body.form, file);
      } else {
        text = renderNew(body.form);
        assertNew(parseProject(text).project);
      }
      ctx.json(200, { ok: true, ...preview(text, ctx.loadConfig()) });
    } catch (e) { ctx.json(400, { error: e.message }); }
    return true;
  }

  if (method === 'POST' && path === '/api/projects') {
    const body = await ctx.readJson();
    if (!body) return ctx.json(400, { error: 'invalid JSON' }) ?? true;
    let text;
    let project;
    try {
      text = renderNew(body.form);
      project = parseProject(text).project;
      assertNew(project);
    } catch (e) { return ctx.json(400, { error: e.message }) ?? true; }
    const file = newProjectFile(project);
    return save(ctx, { project, file, text, up: body.up === true, action: 'create', create: true });
  }
  return false;
}

function assertNew(project) {
  if (project === DASHBOARD_PROJECT) throw new Error(`"${DASHBOARD_PROJECT}" is reserved for the dashboard`);
  if (readMeta(project)) throw new Error(`${project} already exists; edit it instead`);
  if (existsSync(newProjectFile(project))) throw new Error(`${newProjectFile(project)} already exists`);
}

// Renaming changes every hostname (they're built from the project name) and the tunnel
// name, so it is done the safe way: the project must be stopped; `burrow destroy <old>`
// deletes the old tunnel and DNS records first (if that fails nothing else changes); then
// tunnel.yml gets the new `project:` (a file in the import directory is also renamed),
// the new name is remembered, and `burrow up <new>` creates a fresh tunnel and records.
async function rename(ctx, from) {
  try { assertLabel(from, 'project'); } catch { return ctx.json(400, { error: 'bad project' }) ?? true; }
  const file = editableFile(from);
  if (!file) return ctx.json(404, { error: `${from} has no remembered tunnel.yml to rename` }) ?? true;
  const body = await ctx.readJson();
  if (!body) return ctx.json(400, { error: 'invalid JSON' }) ?? true;
  const to = String(body.to ?? '').trim();
  const cfg = ctx.loadConfig();
  let text;
  let plan;
  try {
    assertLabel(to, 'new project name');
    if (to === from) throw new Error('that is the current name');
    assertNew(to);
    const before = readFileSync(file, 'utf8');
    text = renameText(before, to, file);
    const target = file === newProjectFile(from) ? newProjectFile(to) : file;
    if (target !== file && existsSync(target)) throw new Error(`${target} already exists`);
    const hostsOf = (t) => hostsOn(parseProject(t), cfg);
    const a = hostsOf(before);
    const b = hostsOf(text);
    plan = { from, to, file: target, hosts: a.map((h, i) => ({ from: h, to: b[i] })), running: !!runningPid(from) };
  } catch (e) { return ctx.json(400, { error: e.message }) ?? true; }
  if (body.dryRun === true) return ctx.json(200, { ok: true, ...plan }) ?? true;
  if (body.confirm !== true) return ctx.json(400, { error: 'confirm the rename (confirm: true)' }) ?? true;
  if (plan.running) return ctx.json(409, { error: `${from} is running; stop it first (Down), then rename` }) ?? true;
  try {
    const cf = new Cloudflare({ token: cfg.token, accountId: cfg.accountId, zoneId: cfg.zoneId });
    if (await cf.findTunnel(tunnelName(to))) {
      return ctx.json(409, { error: `Cloudflare already has a tunnel named ${tunnelName(to)}; pick another name or remove it first` }) ?? true;
    }
  } catch (e) { return ctx.json(502, { error: `Cloudflare check failed: ${e.message}` }) ?? true; }

  const r = await ctx.withBusy(from, () => ctx.withBusy(to, async () => {
    if (runningPid(from)) return { ok: false, error: `${from} was started meanwhile; stop it first` };
    ctx.log(`rename ${from} -> ${to} (requested from ${ctx.clientIp})`);
    const d = await ctx.runCli(['destroy', from]);
    ctx.invalidate();
    if (!d.ok) return { ok: false, output: d.output, error: `burrow destroy ${from} failed, so nothing was renamed` };
    if (plan.file !== file) {
      mkdirSync(join(plan.file, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(plan.file, text, { flag: 'wx' });
      rmSync(file, { force: true });
    } else writeFileSync(file, text);
    saveMeta(to, { project: to, file: plan.file, hostnames: [] });
    ctx.events.emit('event', { action: 'rename', project: to, ok: true, source: 'dashboard', detail: `from ${from}` });
    const out = { ok: true, renamed: true, ...plan, running: false, output: d.output };
    if (body.up === true) {
      const run = await ctx.runCli(['up', to]);
      out.ok = run.ok;
      out.output += '\n' + run.output;
    }
    ctx.invalidate();
    return out;
  }));
  if (r === null) ctx.json(409, { error: `${from} or ${to} is busy` });
  else ctx.json(r.renamed ? (r.ok ? 200 : 500) : 500, r);
  return true;
}

async function save(ctx, { project, file, text, up, action, create }) {
  const r = await ctx.withBusy(project, async () => {
    if (create) {
      mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(file, text, { flag: 'wx' });
      saveMeta(project, { project, file, hostnames: [] });
    } else writeFileSync(file, text);
    ctx.log(`${action} ${project} tunnel.yml (requested from ${ctx.clientIp})`);
    ctx.events.emit('event', { action, project, ok: true, source: 'dashboard', detail: file });
    const out = { ok: true, saved: true, file, ...preview(text, ctx.loadConfig()) };
    if (!up) return out;
    const run = await ctx.runCli(['up', project]);
    ctx.invalidate();
    return { ...out, ok: run.ok, output: run.output };
  });
  if (!r) ctx.json(409, { error: `${project} is busy` });
  else ctx.json(r.ok ? 200 : 500, r);
  return true;
}

export const html = {
  toolbarMain: '<li><button class="outline" @click="newProject">New project</button></li>',
  rowActions: '<button class="secondary outline" x-show="canEdit(p)" @click="editProject(p)">Edit</button>',
  dialogs: `
<dialog :open="formOpen" class="project-form">
  <article>
    <header><strong x-text="formTitle"></strong></header>
    <form @submit.prevent="saveProject">
      <label>Project name
        <input type="text" name="project" x-model="form.project" :disabled="formEditing" placeholder="acme-shop" autocomplete="off" required>
      </label>
      <label>Domain
        <select x-model="domainPick" @change="onDomainPick" aria-label="Domain">
          <option value="" x-text="defaultDomainLabel"></option>
          <template x-for="d in domainList" :key="d.name"><option :value="d.name" x-text="domainLabel(d)"></option></template>
          <option value="__other__">Other domain…</option>
        </select>
      </label>
      <input type="text" x-show="domainIsOther" x-model="domainOther" placeholder="example.org" aria-label="Other domain" autocomplete="off">
      <small class="muted" x-show="hasDomainHint" x-text="domainHint"></small>
      <label>App: port or URL for <code x-text="rootHost"></code>
        <input type="text" name="app" x-model="form.app" placeholder="3000" autocomplete="off">
      </label>
      <fieldset>
        <legend>Extra paths on the app</legend>
        <template x-for="(row, i) in form.paths" :key="i">
          <div class="form-row">
            <input type="text" x-model="row.path" placeholder="/api" aria-label="Path" autocomplete="off">
            <input type="text" x-model="row.target" placeholder="3001" aria-label="Port or URL" autocomplete="off">
            <button type="button" class="secondary outline" @click="removePath(i)" aria-label="Remove path">&times;</button>
          </div>
        </template>
        <button type="button" class="secondary outline small" @click="addPath">Add path</button>
      </fieldset>
      <fieldset>
        <legend>Sub-services (<code>&lt;service&gt;-&lt;project&gt;</code>)</legend>
        <template x-for="(row, i) in form.services" :key="i">
          <div class="form-row">
            <input type="text" x-model="row.name" placeholder="mail" aria-label="Service name" autocomplete="off">
            <input type="text" x-model="row.target" placeholder="8025" aria-label="Port or URL" autocomplete="off">
            <button type="button" class="secondary outline" @click="removeService(i)" aria-label="Remove service">&times;</button>
          </div>
        </template>
        <button type="button" class="secondary outline small" @click="addService">Add sub-service</button>
      </fieldset>
      <label><input type="checkbox" role="switch" x-model="form.autostart"> Start at boot (<code>autostart: true</code>)</label>
      <label><input type="checkbox" x-model="formUp"> Run <code>burrow up</code> after saving</label>
      <p class="error" x-show="hasFormError" x-text="formError"></p>
      <div x-show="hasPreview" class="form-preview">
        <small>Hostnames</small>
        <ul><template x-for="h in preview.hostnames" :key="h"><li><code x-text="h"></code></li></template></ul>
        <details><summary>tunnel.yml</summary><pre x-text="preview.yaml"></pre></details>
      </div>
      <footer>
        <button type="button" class="secondary" @click="closeForm">Cancel</button>
        <button type="button" class="secondary outline" x-show="formEditing" :disabled="formBusy" @click="openRename">Rename…</button>
        <button type="button" class="secondary outline" :disabled="formBusy" @click="checkProject">Check</button>
        <button type="submit" :aria-busy="formBusy" :disabled="formBusy">Save</button>
      </footer>
    </form>
  </article>
</dialog>
<dialog :open="renameOpen" class="rename-dialog">
  <article>
    <header><strong>Rename <span x-text="form.project"></span></strong></header>
    <p class="error" x-show="formRunning">It's running. Stop it first (Down): renaming deletes and recreates its tunnel.</p>
    <label>New name
      <input type="text" x-model="renameTo" @input="onRenameInput" placeholder="acme-store" aria-label="New project name" autocomplete="off">
    </label>
    <p class="error" x-show="hasRenameError" x-text="renameError"></p>
    <div x-show="hasRenamePlan" class="rename-plan">
      <p><small>The tunnel and DNS records of <strong x-text="form.project"></strong> are deleted, the new name is written to
        <code x-text="renameFile"></code>, and new ones are created on the next start. Old URLs stop working:</small></p>
      <ul><template x-for="row in renameHosts" :key="row.from"><li><code x-text="row.from"></code> → <code x-text="row.to"></code></li></template></ul>
    </div>
    <label><input type="checkbox" x-model="renameUp"> Run <code>burrow up</code> after renaming</label>
    <footer>
      <button class="secondary" @click="closeRename">Cancel</button>
      <button class="danger" :disabled="cannotRename" :aria-busy="renameBusy" @click="doRename">Rename</button>
    </footer>
  </article>
</dialog>`,
};

export const css = `
.project-form article{width:min(680px,100%)}
.project-form fieldset{margin-bottom:.75rem}
.form-row{display:grid;grid-template-columns:1fr 1fr auto;gap:.4rem;align-items:start}
.form-row input{margin-bottom:.4rem}.form-row button{width:auto;padding:.45rem .8rem;margin:0}
button.small{width:auto;padding:.25rem .7rem;font-size:.8rem}
.form-preview pre{max-height:220px;overflow:auto;font-size:.78rem}
.form-preview ul{margin-bottom:.4rem}
.rename-dialog article{width:min(560px,100%)}.rename-plan ul{margin-bottom:.5rem}
`;

export const js = `
burrowPanel(function () {
  function blank() { return { project: '', domain: '', app: '', paths: [], services: [], autostart: false }; }
  function noPreview() { return { hostnames: [], yaml: '' }; }
  return {
    formOpen: false, formEditing: false, form: blank(), formUp: true, formError: '', formBusy: false, preview: noPreview(),
    domainList: [], domainDefault: '', domainError: '', domainPick: '', domainOther: '', domainStart: '',
    formRunning: false, renameOpen: false, renameTo: '', renamePlan: null, renameError: '', renameBusy: false, renameUp: true, renameTimer: null,
    get hasRenameError() { return this.renameError.length > 0; },
    get hasRenamePlan() { return !!this.renamePlan; },
    get renameHosts() { return this.renamePlan ? this.renamePlan.hosts : []; },
    get renameFile() { return this.renamePlan ? this.renamePlan.file : ''; },
    get cannotRename() { return !this.renamePlan || this.renameBusy || this.formRunning || this.renamePlan.to !== this.renameTo.trim(); },
    renameUrl: function () { return '/api/projects/' + encodeURIComponent(this.form.project) + '/rename'; },
    openRename: function () { this.renameTo = ''; this.renamePlan = null; this.renameError = ''; this.renameUp = true; this.renameOpen = true; },
    closeRename: function () { this.renameOpen = false; },
    onRenameInput: function () {
      var self = this;
      clearTimeout(this.renameTimer);
      this.renamePlan = null;
      this.renameTimer = setTimeout(function () { self.checkRename(); }, 300);
    },
    checkRename: async function () {
      var to = this.renameTo.trim();
      this.renameError = '';
      if (!to) return;
      try {
        var r = await post(this.renameUrl(), { to: to, dryRun: true });
        var j = await r.json().catch(function () { return {}; });
        if (to !== this.renameTo.trim()) return;
        if (r.ok) this.renamePlan = j; else this.renameError = j.error || ('HTTP ' + r.status);
      } catch (e) { this.renameError = 'Network error'; }
    },
    doRename: async function () {
      if (this.cannotRename) return;
      this.renameBusy = true; this.renameError = '';
      try {
        var r = await post(this.renameUrl(), { to: this.renameTo.trim(), confirm: true, up: this.renameUp });
        if (r.status === 401) { location.assign('/login'); return; }
        var j = await r.json().catch(function () { return {}; });
        if (j.renamed) {
          this.renameOpen = false; this.formOpen = false;
          this.showToast((j.ok ? '✓ ' : '✗ ') + 'renamed ' + j.from + ' → ' + j.to + (j.output ? '\\n' + j.output : ''), !!j.ok, 12000);
          this.load();
        } else this.renameError = j.error || ('HTTP ' + r.status);
      } catch (e) { this.renameError = 'Network error'; } finally { this.renameBusy = false; }
    },

    get formTitle() { return this.formEditing ? 'Edit ' + this.form.project : 'New project'; },
    get hasFormError() { return this.formError.length > 0; },
    get hasPreview() { return this.preview.yaml.length > 0; },
    get rootHost() { return (this.form.project || '<project>') + '.' + (this.formDomain() || this.domainDefault || '<domain>'); },
    get defaultDomainLabel() { return this.domainDefault ? this.domainDefault + ' (default)' : 'Default (BURROW_DOMAIN)'; },
    get domainIsOther() { return this.domainPick === '__other__'; },
    get domainHint() {
      if (this.formEditing && this.formDomain() !== this.domainStart) {
        return 'Changing the domain moves every hostname: the next burrow up deletes the old DNS records and creates new ones on the same tunnel.';
      }
      return this.domainError ? 'Could not list Cloudflare zones (' + this.domainError + '); pick Other to type one.' : '';
    },
    get hasDomainHint() { return this.domainHint.length > 0; },
    domainLabel: function (d) {
      var extra = d.status && d.status !== 'active' ? ' (' + d.status + ')' : (d.sources.indexOf('cloudflare') < 0 ? ' (' + d.sources.join(', ') + ')' : '');
      return d.name + extra;
    },
    formDomain: function () { return this.domainPick === '__other__' ? this.domainOther.trim().toLowerCase() : this.domainPick; },
    formPayload: function () { return Object.assign({}, this.form, { domain: this.formDomain() }); },
    onDomainPick: function () { if (this.domainIsOther) this.domainOther = ''; this.preview = noPreview(); },
    loadDomains: async function () {
      var want = this.form.domain || '';
      this.domainStart = want; this.domainOther = '';
      try {
        var j = await getJson('/api/domains');
        this.domainList = j.domains; this.domainDefault = j.default || ''; this.domainError = j.error || '';
      } catch (e) { this.domainError = e.message; }
      var known = !want || this.domainList.some(function (d) { return d.name === want; });
      var self = this;
      this.$nextTick(function () {
        if (known) self.domainPick = want; else { self.domainPick = '__other__'; self.domainOther = want; }
      });
    },
    canEdit: function (p) { return !!p.editable; },

    openForm: function (form, editing, up) {
      this.form = form; this.formEditing = editing; this.formUp = up;
      this.formError = ''; this.preview = noPreview(); this.formOpen = true;
      this.loadDomains();
    },
    newProject: function () { this.openForm(blank(), false, true); },
    editProject: async function (p) {
      try {
        var j = await getJson('/api/projects/' + encodeURIComponent(p.project) + '/config');
        this.formRunning = !!p.running;
        this.openForm(j.form, true, !!p.running);
      } catch (e) { this.showToast('✗ ' + e.message, false); }
    },
    closeForm: function () { this.formOpen = false; },
    addPath: function () { this.form.paths.push({ path: '', target: '' }); },
    removePath: function (i) { this.form.paths.splice(i, 1); },
    addService: function () { this.form.services.push({ name: '', target: '' }); },
    removeService: function (i) { this.form.services.splice(i, 1); },
    formUrl: function () {
      return this.formEditing ? '/api/projects/' + encodeURIComponent(this.form.project) + '/config' : '/api/projects';
    },
    checkProject: async function () {
      this.formError = '';
      try {
        var r = await post('/api/projects/check', { form: this.formPayload(), editing: this.formEditing });
        var j = await r.json().catch(function () { return {}; });
        if (r.ok) this.preview = { hostnames: j.hostnames || [], yaml: j.yaml || '' };
        else { this.preview = noPreview(); this.formError = j.error || ('HTTP ' + r.status); }
      } catch (e) { this.formError = 'Network error'; }
    },
    saveProject: async function () {
      this.formBusy = true; this.formError = '';
      try {
        var r = await post(this.formUrl(), { form: this.formPayload(), up: this.formUp });
        if (r.status === 401) { location.assign('/login'); return; }
        var j = await r.json().catch(function () { return {}; });
        if (j.saved) {
          this.formOpen = false;
          this.showToast((j.ok ? '✓ ' : '✗ ') + 'saved ' + j.file + (j.output ? '\\n' + j.output : ''), !!j.ok, 12000);
          this.load();
        } else this.formError = j.error || ('HTTP ' + r.status);
      } catch (e) { this.formError = 'Network error'; } finally { this.formBusy = false; }
    },
  };
});
`;
