// Panel: bulk actions and start-at-boot. Tick projects to start or stop them together;
// a switch per project sets `autostart: true` in its tunnel.yml; and the bar under the
// table installs the systemd unit from `burrow service` that brings them up at boot.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';
import { assertLabel } from '../../naming.js';
import { parseProject, DASHBOARD_PROJECT } from '../../project.js';
import { readMeta } from '../../process.js';
import { autostartProjects, unitPath, UNIT_NAME } from '../../service.js';

export const order = 90;
const MAX_BULK = 50;

const configList = (cfg) => (cfg.autostart || '').split(',').map((s) => s.trim()).filter(Boolean);
const projectFile = (project) => {
  if (project === DASHBOARD_PROJECT) return null;
  const file = readMeta(project)?.file;
  return file && existsSync(file) ? file : null;
};

// Set or remove `autostart: true`, keeping the rest of the file (comments included).
export function setAutostart(text, enabled, source = 'tunnel.yml') {
  const doc = YAML.parseDocument(text);
  if (enabled) doc.set('autostart', true);
  else doc.delete('autostart');
  const out = doc.toString({ lineWidth: 0 });
  parseProject(out, source);
  return out;
}

// Cached briefly: systemctl runs synchronously and the page polls.
let unitCache = { at: 0, data: null };
function unitState(fresh = false) {
  if (!fresh && unitCache.data && Date.now() - unitCache.at < 15000) return unitCache.data;
  const run = (...a) => {
    const r = spawnSync(process.env.BURROW_SYSTEMCTL || 'systemctl', ['--user', ...a, UNIT_NAME], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
    return r.error ? 'unknown' : (r.stdout || '').trim() || 'unknown';
  };
  unitCache = { at: Date.now(), data: { installed: existsSync(unitPath()), enabled: run('is-enabled'), active: run('is-active') } };
  return unitCache.data;
}

export async function enrich(projects, ctx) {
  const cfg = ctx.loadConfig();
  const fromConfig = new Set(configList(cfg));
  for (const p of projects) {
    let fromFile = false;
    const file = projectFile(p.project);
    if (file) { try { fromFile = parseProject(readFileSync(file, 'utf8'), file).autostart; } catch {} }
    p.autostart = fromFile || fromConfig.has(p.project);
    p.autostartSource = fromConfig.has(p.project) ? 'config' : fromFile ? 'file' : null;
    p.autostartEditable = !!file && !fromConfig.has(p.project);
  }
}

export async function route(ctx) {
  const { method, path } = ctx;
  if (method === 'GET' && path === '/api/boot') {
    return ctx.json(200, { ...unitState(), unit: UNIT_NAME, projects: autostartProjects(ctx.loadConfig()) }) ?? true;
  }
  if (method !== 'POST') return false;

  if (path === '/api/boot') {
    const body = await ctx.readJson();
    if (!body) return ctx.json(400, { error: 'invalid JSON' }) ?? true;
    let args;
    if (body.action === 'install') args = ['service', 'install', '--now'];
    else if (body.action === 'uninstall') {
      if (body.confirm !== true) return ctx.json(400, { error: 'confirm the uninstall' }) ?? true;
      args = ['service', 'uninstall'];
    } else return ctx.json(400, { error: 'action must be install or uninstall' }) ?? true;
    const r = await ctx.withBusy('(boot)', () => ctx.runCli(args, 300000));
    if (!r) return ctx.json(409, { error: 'busy' }) ?? true;
    ctx.invalidate();
    return ctx.json(r.ok ? 200 : 500, { ...r, ...unitState(true) }) ?? true;
  }

  let m = path.match(/^\/api\/autostart\/([^/]+)$/);
  if (m) {
    const project = m[1];
    try { assertLabel(project, 'project'); } catch { return ctx.json(400, { error: 'bad project' }) ?? true; }
    const body = await ctx.readJson();
    if (!body || typeof body.enabled !== 'boolean') return ctx.json(400, { error: 'enabled must be true or false' }) ?? true;
    if (configList(ctx.loadConfig()).includes(project)) {
      return ctx.json(409, { error: `${project} is in BURROW_AUTOSTART in the config; change it there` }) ?? true;
    }
    const file = projectFile(project);
    if (!file) return ctx.json(404, { error: `${project} has no remembered tunnel.yml` }) ?? true;
    try {
      writeFileSync(file, setAutostart(readFileSync(file, 'utf8'), body.enabled, file));
    } catch (e) { return ctx.json(400, { error: e.message }) ?? true; }
    ctx.log(`autostart ${body.enabled ? 'on' : 'off'} for ${project} (requested from ${ctx.clientIp})`);
    ctx.events.emit('event', { action: `autostart ${body.enabled ? 'on' : 'off'}`, project, ok: true, detail: file });
    return ctx.json(200, { ok: true, project, autostart: body.enabled, file }) ?? true;
  }

  if (path === '/api/bulk') {
    const body = await ctx.readJson();
    if (!body) return ctx.json(400, { error: 'invalid JSON' }) ?? true;
    if (!['up', 'down', 'restart'].includes(body.action)) return ctx.json(400, { error: 'action must be up, down or restart' }) ?? true;
    const list = Array.isArray(body.projects) ? [...new Set(body.projects)] : [];
    if (!list.length || list.length > MAX_BULK) return ctx.json(400, { error: `pick 1 to ${MAX_BULK} projects` }) ?? true;
    for (const p of list) {
      try { assertLabel(p, 'project'); } catch { return ctx.json(400, { error: `bad project ${String(p).slice(0, 40)}` }) ?? true; }
      if (p === DASHBOARD_PROJECT) return ctx.json(400, { error: 'the dashboard project is not part of bulk actions' }) ?? true;
    }
    ctx.log(`bulk ${body.action} ${list.join(', ')} (requested from ${ctx.clientIp})`);
    const results = [];
    for (const project of list) { // one at a time: each `up` talks to the Cloudflare API
      const r = await ctx.withBusy(project, () => ctx.runCli([body.action, project]));
      results.push(r ? { project, ok: r.ok, output: r.output.slice(-2000) } : { project, ok: false, output: `${project} is busy` });
    }
    ctx.invalidate();
    const ok = results.every((r) => r.ok);
    return ctx.json(ok ? 200 : 207, { ok, results }) ?? true;
  }
  return false;
}

export const html = {
  headLead: '<th class="pick"><input type="checkbox" :checked="allPicked" @change="togglePickAll" aria-label="Select all projects"></th>',
  rowLead: '<td class="pick"><input type="checkbox" :disabled="p.builtIn" :checked="isPicked(p)" @change="togglePick(p)" :aria-label="pickLabel(p)"></td>',
  headCols: '<th title="Start at boot (autostart)">Boot</th>',
  rowCols: '<td class="col-boot" data-label="Boot"><input type="checkbox" role="switch" :checked="p.autostart" :disabled="autostartDisabled(p)" :title="autostartTitle(p)" @change="toggleAutostart(p)" :aria-label="autostartTitle(p)"></td>',
  toolbar: `<li x-show="hasPicks"><small x-text="pickedText"></small></li>
<li x-show="hasPicks"><button :aria-busy="bulkBusy" :disabled="bulkBusy" @click="bulkUp">Start</button></li>
<li x-show="hasPicks"><button class="secondary" :disabled="bulkBusy" @click="bulkDown">Stop</button></li>`,
  sections: `
<div class="boot-bar" x-show="hasProjects">
  <small>Start at boot: <code x-text="bootUnit"></code> <span class="badge" :class="bootClass" x-text="bootText"></span>
    <span x-text="bootProjectsText"></span></small>
  <button class="secondary outline small" x-show="bootCanInstall" :aria-busy="bootBusy" :disabled="bootBusy" @click="installBoot" x-text="bootInstallLabel"></button>
  <button class="danger outline small" x-show="bootInstalled" :disabled="bootBusy" @click="askUninstallBoot">Uninstall</button>
</div>`,
  dialogs: `
<dialog :open="bootUninstallOpen">
  <article>
    <header><strong>Uninstall the boot service?</strong></header>
    <p>This disables and removes <code>burrow.service</code>. systemd runs its stop command, which is
      <code>burrow down</code>: <strong>every running connector stops</strong>, the dashboard's own tunnel included.
      Tunnels and DNS records are kept.</p>
    <footer>
      <button class="secondary" @click="closeUninstallBoot">Cancel</button>
      <button class="danger" @click="uninstallBoot">Uninstall</button>
    </footer>
  </article>
</dialog>`,
};

export const css = `
th.pick,td.pick{width:2rem}.pick input{margin:0}
.boot-bar{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin:.5rem 0 1rem;color:var(--pico-muted-color)}
.boot-bar button.small{width:auto;margin:0;padding:.2rem .6rem;font-size:.8rem}
`;

export const js = `
burrowPanel(function () {
  return {
    picked: [], bulkBusy: false, boot: { installed: false, enabled: 'unknown', active: 'unknown', projects: [], unit: 'burrow.service' },
    bootBusy: false, bootUninstallOpen: false, bootAt: 0,

    onLoad: function (data) {
      var names = data.projects.map(function (p) { return p.project; });
      this.picked = this.picked.filter(function (n) { return names.indexOf(n) >= 0; });
      if (Date.now() - this.bootAt > 30000) this.loadBoot();
    },
    get pickable() { return this.projects.filter(function (p) { return !p.builtIn; }); },
    get hasPicks() { return this.picked.length > 0; },
    get pickedText() { return this.picked.length + ' selected'; },
    get allPicked() { return this.pickable.length > 0 && this.picked.length === this.pickable.length; },
    isPicked: function (p) { return this.picked.indexOf(p.project) >= 0; },
    pickLabel: function (p) { return 'Select ' + p.project; },
    togglePick: function (p) {
      var i = this.picked.indexOf(p.project);
      if (i >= 0) this.picked.splice(i, 1); else this.picked.push(p.project);
    },
    togglePickAll: function () {
      this.picked = this.allPicked ? [] : this.pickable.map(function (p) { return p.project; });
    },
    runBulk: async function (action) {
      var list = this.picked.slice();
      this.bulkBusy = true;
      var self = this;
      list.forEach(function (n) { self.busy[n] = true; });
      this.showToast(action + ' ' + list.join(', ') + '…', true, 300000);
      try {
        var r = await post('/api/bulk', { action: action, projects: list });
        if (r.status === 401) { location.assign('/login'); return; }
        var j = await r.json().catch(function () { return {}; });
        var text = (j.results || []).map(function (x) { return (x.ok ? '✓ ' : '✗ ') + x.project; }).join('\\n');
        this.showToast((j.ok ? '✓ ' : '✗ ') + action + ' ' + list.length + ' project(s)\\n' + (text || j.error || ''), !!j.ok, 12000);
        if (j.ok) this.picked = [];
      } catch (e) { this.showToast('✗ ' + action + ': network error', false); } finally {
        list.forEach(function (n) { self.busy[n] = false; });
        this.bulkBusy = false; this.load();
      }
    },
    bulkUp: function () { this.runBulk('up'); },
    bulkDown: function () { this.runBulk('down'); },

    autostartDisabled: function (p) { return !p.autostartEditable; },
    autostartTitle: function (p) {
      if (p.autostartSource === 'config') return 'Set by BURROW_AUTOSTART in the config';
      if (p.builtIn) return 'Add burrow to BURROW_AUTOSTART in the config to start the dashboard at boot';
      if (!p.autostartEditable) return 'No remembered tunnel.yml';
      return p.autostart ? 'Starts at boot (autostart: true)' : 'Start at boot';
    },
    toggleAutostart: async function (p) {
      var want = !p.autostart;
      try {
        var r = await post('/api/autostart/' + encodeURIComponent(p.project), { enabled: want });
        var j = await r.json().catch(function () { return {}; });
        if (r.ok) { p.autostart = want; this.showToast('✓ ' + p.project + (want ? ' starts at boot' : ' no longer starts at boot'), true, 4000); }
        else this.showToast('✗ ' + (j.error || ('HTTP ' + r.status)), false);
      } catch (e) { this.showToast('✗ network error', false); }
      this.load();
      this.loadBoot();
    },

    loadBoot: async function () { this.bootAt = Date.now(); try { this.boot = await getJson('/api/boot'); } catch (e) {} },
    get bootUnit() { return this.boot.unit; },
    get bootInstalled() { return this.boot.installed; },
    get bootCanInstall() { return !this.boot.installed || this.boot.active !== 'active'; },
    get bootInstallLabel() { return this.boot.installed ? 'Start it' : 'Install'; },
    get bootText() { return this.boot.installed ? this.boot.enabled + ', ' + this.boot.active : 'not installed'; },
    get bootClass() { return !this.boot.installed ? '' : this.boot.enabled === 'enabled' ? 'ok' : 'warn'; },
    get bootProjectsText() {
      var n = this.boot.projects.length;
      return n ? '· brings up ' + this.boot.projects.join(', ') : '· no projects marked yet';
    },
    bootPost: async function (body, okText) {
      this.bootBusy = true;
      try {
        var r = await post('/api/boot', body);
        var j = await r.json().catch(function () { return {}; });
        this.showToast((r.ok ? '✓ ' + okText : '✗ boot service') + '\\n' + (j.output || j.error || ''), r.ok, 12000);
      } catch (e) { this.showToast('✗ network error', false); } finally { this.bootBusy = false; this.loadBoot(); }
    },
    installBoot: function () { this.bootPost({ action: 'install' }, 'boot service installed'); },
    askUninstallBoot: function () { this.bootUninstallOpen = true; },
    closeUninstallBoot: function () { this.bootUninstallOpen = false; },
    uninstallBoot: function () { this.bootUninstallOpen = false; this.bootPost({ action: 'uninstall', confirm: true }, 'boot service removed'); },
  };
});
`;
