// Panel: add or edit a project from the dashboard. Writes a validated tunnel.yml and
// can run `burrow up` right after. File paths never come from the browser: new files
// go where `burrow import` puts them, edits go to the file `burrow up` remembered.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertLabel } from '../../naming.js';
import { parseProject, hostnames, DASHBOARD_PROJECT } from '../../project.js';
import { readMeta, saveMeta } from '../../process.js';
import { isShare } from '../../share.js';
import { defaultImportDir } from '../../transfer.js';
import { formFromText, renderNew, renderEdit } from '../../project-form.js';

export const order = 10;

// The remembered tunnel.yml of a project the form may edit, or null.
export function editableFile(project) {
  if (project === DASHBOARD_PROJECT || isShare(project)) return null;
  const file = readMeta(project)?.file;
  return file && existsSync(file) ? file : null;
}

export const newProjectFile = (project) => join(defaultImportDir(), `${project}.tunnel.yml`);

function preview(text, cfg) {
  const proj = parseProject(text);
  return { yaml: text, hostnames: cfg.domain ? hostnames(proj, cfg.domain).map((h) => h.hostname) : [] };
}

export async function enrich(projects) {
  for (const p of projects) p.editable = !p.builtIn && !!editableFile(p.project);
}

export async function route(ctx) {
  const { method, path } = ctx;
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
  toolbar: '<li><button class="outline" @click="newProject">New project</button></li>',
  rowActions: '<button class="secondary outline" x-show="canEdit(p)" @click="editProject(p)">Edit</button>',
  dialogs: `
<dialog :open="formOpen" class="project-form">
  <article>
    <header><strong x-text="formTitle"></strong></header>
    <form @submit.prevent="saveProject">
      <label>Project name
        <input type="text" name="project" x-model="form.project" :disabled="formEditing" placeholder="acme-shop" autocomplete="off" required>
      </label>
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
        <button type="button" class="secondary outline" :disabled="formBusy" @click="checkProject">Check</button>
        <button type="submit" :aria-busy="formBusy" :disabled="formBusy">Save</button>
      </footer>
    </form>
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
`;

export const js = `
burrowPanel(function () {
  function blank() { return { project: '', app: '', paths: [], services: [], autostart: false }; }
  function noPreview() { return { hostnames: [], yaml: '' }; }
  return {
    formOpen: false, formEditing: false, form: blank(), formUp: true, formError: '', formBusy: false, preview: noPreview(),

    get formTitle() { return this.formEditing ? 'Edit ' + this.form.project : 'New project'; },
    get hasFormError() { return this.formError.length > 0; },
    get hasPreview() { return this.preview.yaml.length > 0; },
    get rootHost() { return (this.form.project || '<project>') + '.<domain>'; },
    canEdit: function (p) { return !!p.editable; },

    openForm: function (form, editing, up) {
      this.form = form; this.formEditing = editing; this.formUp = up;
      this.formError = ''; this.preview = noPreview(); this.formOpen = true;
    },
    newProject: function () { this.openForm(blank(), false, true); },
    editProject: async function (p) {
      try {
        var j = await getJson('/api/projects/' + encodeURIComponent(p.project) + '/config');
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
        var r = await post('/api/projects/check', { form: this.form, editing: this.formEditing });
        var j = await r.json().catch(function () { return {}; });
        if (r.ok) this.preview = { hostnames: j.hostnames || [], yaml: j.yaml || '' };
        else { this.preview = noPreview(); this.formError = j.error || ('HTTP ' + r.status); }
      } catch (e) { this.formError = 'Network error'; }
    },
    saveProject: async function () {
      this.formBusy = true; this.formError = '';
      try {
        var r = await post(this.formUrl(), { form: this.form, up: this.formUp });
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
