// Panel: Cloudflare Access per service. Shows which services are private (behind Access),
// whether that's applied in Cloudflare yet, and toggles `private:` / `allow:` in the
// project's tunnel.yml (edited in place, so comments and other keys stay). Access apps are
// created or removed by `burrow up`, which the panel can run right away. Services stay
// public unless you opt in; making a service public again needs an explicit confirmation.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';
import { assertLabel } from '../../naming.js';
import { parseProject, hostnames, DASHBOARD_PROJECT } from '../../project.js';
import { readMeta, runningPid } from '../../process.js';
import { isShare } from '../../share.js';
import { accessStateFile, parseEmails, privateHosts, validAllow } from '../../access.js';

export const order = 45;

function projectFile(project) {
  if (project === DASHBOARD_PROJECT || isShare(project)) return null;
  const file = readMeta(project)?.file;
  return file && existsSync(file) ? file : null;
}
function appliedApps(project) {
  try { return JSON.parse(readFileSync(accessStateFile(project), 'utf8')).apps || []; } catch { return []; }
}
const domainOf = (proj, cfg) => proj.domain || cfg.domain;

// [{ service, hostname, private, allow, effective, applied }] for a project's tunnel.yml.
export function accessView(project, cfg) {
  const file = projectFile(project);
  if (!file) return null;
  const proj = parseProject(readFileSync(file, 'utf8'), file);
  const domain = domainOf(proj, cfg);
  const hosts = domain ? hostnames(proj, domain) : proj.services.map(() => ({ hostname: null }));
  const applied = appliedApps(project);
  const defaults = parseEmails(cfg.accessEmails);
  const services = proj.services.map((s, i) => ({
    service: s.name,
    hostname: hosts[i].hostname,
    private: !!s.private,
    allow: s.allow || [],
    effective: s.private ? (s.allow?.length ? s.allow : defaults) : [],
    applied: applied.some((a) => a.name === `burrow:${project}:${s.name}`),
  }));
  return { project, file, services, defaults, pending: services.some((s) => s.private !== s.applied) };
}

// Apply [{ service, private, allow? }] to the tunnel.yml text. Returns { text, toPublic }.
export function applyAccess(text, changes, cfg, source = 'tunnel.yml') {
  const before = parseProject(text, source);
  const doc = YAML.parseDocument(text);
  const seq = doc.get('services');
  const items = seq?.items || [];
  const toPublic = [];
  for (const c of changes) {
    const name = String(c?.service ?? '');
    const node = items.find((it) => YAML.isMap(it) && String(it.get('name')) === name);
    if (!node) throw new Error(`no service "${name}" in ${source}`);
    const was = before.services.find((s) => s.name === name);
    if (c.private === true) {
      node.set('private', true);
      const allow = parseEmails(c.allow);
      const bad = allow.filter((e) => !validAllow(e));
      if (bad.length) throw new Error(`invalid allow entries ${bad.join(', ')} (use emails or @domain)`);
      if (allow.length) node.set('allow', doc.createNode(allow, { flow: true }));
      else node.delete('allow');
    } else if (c.private === false) {
      if (was?.private) toPublic.push(name);
      node.delete('private');
      node.delete('allow');
    } else throw new Error('private must be true or false');
  }
  const out = doc.toString({ lineWidth: 0 });
  const proj = parseProject(out, source); // same rules as `burrow up`
  const domain = domainOf(proj, cfg);
  privateHosts(proj, domain ? hostnames(proj, domain) : proj.services.map(() => ({ hostname: '' })), cfg);
  return { text: out, toPublic };
}

export async function enrich(projects, ctx) {
  const cfg = ctx.loadConfig();
  for (const p of projects) {
    try {
      const v = accessView(p.project, cfg);
      if (!v) continue;
      p.accessEditable = true;
      p.privateCount = v.services.filter((s) => s.private).length;
      p.accessPending = v.pending;
    } catch { /* invalid tunnel.yml: the row shows other errors */ }
  }
}

export async function route(ctx) {
  const m = ctx.path.match(/^\/api\/access\/([^/]+)$/);
  if (!m) return false;
  const project = m[1];
  try { assertLabel(project, 'project'); } catch { return ctx.json(400, { error: 'bad project' }) ?? true; }
  const cfg = ctx.loadConfig();
  let view;
  try { view = accessView(project, cfg); } catch (e) { return ctx.json(422, { error: e.message }) ?? true; }
  if (!view) return ctx.json(404, { error: `${project} has no remembered tunnel.yml` }) ?? true;
  if (ctx.method === 'GET') return ctx.json(200, { ...view, running: !!runningPid(project) }) ?? true;
  if (ctx.method !== 'POST') return false;
  const body = await ctx.readJson();
  if (!body) return ctx.json(400, { error: 'invalid JSON' }) ?? true;
  if (!Array.isArray(body.services) || !body.services.length || body.services.length > 50) {
    return ctx.json(400, { error: 'services must be a non-empty list' }) ?? true;
  }
  let next;
  try { next = applyAccess(readFileSync(view.file, 'utf8'), body.services, cfg, view.file); } catch (e) {
    return ctx.json(400, { error: e.message }) ?? true;
  }
  if (next.toPublic.length && body.confirmPublic !== true) {
    return ctx.json(400, { error: `confirm making ${next.toPublic.join(', ')} public (confirmPublic: true)`, toPublic: next.toPublic }) ?? true;
  }
  const r = await ctx.withBusy(project, async () => {
    writeFileSync(view.file, next.text);
    ctx.log(`access ${project}: ${body.services.map((s) => `${s.service}=${s.private ? 'private' : 'public'}`).join(' ')} (requested from ${ctx.clientIp})`);
    ctx.events.emit('event', { action: 'access', project, ok: true, source: 'dashboard', detail: next.toPublic.length ? `public: ${next.toPublic.join(', ')}` : 'saved' });
    const out = { ok: true, saved: true, file: view.file, toPublic: next.toPublic };
    if (body.up !== true) return { ...out, ...accessView(project, cfg) };
    const run = await ctx.runCli(['up', project]);
    ctx.invalidate();
    return { ...out, ...accessView(project, cfg), ok: run.ok, output: run.output };
  });
  if (!r) return ctx.json(409, { error: `${project} is busy` }) ?? true;
  ctx.json(r.ok ? 200 : 500, r);
  return true;
}

export const html = {
  rowBadges: '<span class="badge" x-show="hasPrivate(p)" :class="accessBadgeClass(p)" :title="accessBadgeTitle(p)" x-text="accessBadge(p)"></span>',
  rowActions: '<button class="secondary outline" x-show="canAccess(p)" @click="openAccess(p)">Access</button>',
  dialogs: `
<dialog :open="accessOpen" class="access-dialog">
  <article>
    <header><strong>Cloudflare Access: <span x-text="accessProject"></span></strong></header>
    <p><small class="muted">Private services ask visitors to sign in with an allowed email (Cloudflare one-time PIN) before the request reaches your app. Public is the default.</small></p>
    <template x-for="s in accessRows" :key="s.service">
      <div class="access-row">
        <label><input type="checkbox" role="switch" x-model="s.private"> <code x-text="s.hostname"></code></label>
        <small class="badge" :class="appliedClass(s)" x-text="appliedText(s)"></small>
        <input type="text" x-show="s.private" x-model="s.allowText" :placeholder="allowPlaceholder" aria-label="Allowed emails or @domains" autocomplete="off">
      </div>
    </template>
    <label><input type="checkbox" x-model="accessUp"> Apply now (<code>burrow up</code>)</label>
    <p class="error" x-show="hasAccessError" x-text="accessError"></p>
    <div x-show="hasToPublic" class="access-confirm">
      <p><strong>These become public:</strong> anyone with the link can reach them.</p>
      <ul><template x-for="h in toPublicHosts" :key="h"><li><code x-text="h"></code></li></template></ul>
      <label><input type="checkbox" x-model="accessConfirm"> I understand, make them public</label>
    </div>
    <footer>
      <button class="secondary" @click="closeAccess">Cancel</button>
      <button :class="saveAccessClass" :disabled="cannotSaveAccess" :aria-busy="accessBusy" @click="saveAccess">Save</button>
    </footer>
  </article>
</dialog>`,
};

export const css = `
.access-dialog article{width:min(620px,100%)}
.access-row{display:grid;grid-template-columns:1fr auto;gap:.2rem .6rem;align-items:center;margin-bottom:.6rem}
.access-row label{margin:0}.access-row input[type=text]{grid-column:1/-1;margin:0}
.access-confirm{border-left:3px solid #dc2626;padding-left:.75rem;margin:.5rem 0}
`;

export const js = `
burrowPanel(function () {
  return {
    accessOpen: false, accessProject: '', accessRows: [], accessDefaults: [], accessUp: false, accessBusy: false,
    accessError: '', accessConfirm: false,
    get hasAccessError() { return this.accessError.length > 0; },
    get allowPlaceholder() { return this.accessDefaults.length ? 'Default: ' + this.accessDefaults.join(', ') : 'ana@example.dev, @example.dev'; },
    get toPublicHosts() { return this.accessRows.filter(function (s) { return s.wasPrivate && !s.private; }).map(function (s) { return s.hostname || s.service; }); },
    get hasToPublic() { return this.toPublicHosts.length > 0; },
    get cannotSaveAccess() { return this.accessBusy || (this.hasToPublic && !this.accessConfirm); },
    get saveAccessClass() { return this.hasToPublic ? 'danger' : ''; },
    canAccess: function (p) { return !!p.accessEditable; },
    hasPrivate: function (p) { return p.privateCount > 0; },
    accessBadge: function (p) { return p.accessPending ? 'access: pending' : 'private ' + p.privateCount; },
    accessBadgeClass: function (p) { return p.accessPending ? 'warn' : 'ok'; },
    accessBadgeTitle: function (p) { return p.accessPending ? 'Access changes apply on the next burrow up' : 'Behind Cloudflare Access'; },
    appliedText: function (s) {
      if (s.private === s.applied) return s.applied ? 'protected' : 'public';
      return s.private ? 'not applied yet' : 'still protected';
    },
    appliedClass: function (s) { return s.private === s.applied ? (s.applied ? 'ok' : '') : 'warn'; },
    openAccess: async function (p) {
      this.accessError = ''; this.accessConfirm = false;
      try {
        var j = await getJson('/api/access/' + encodeURIComponent(p.project));
        this.accessProject = p.project; this.accessDefaults = j.defaults; this.accessUp = !!j.running;
        this.accessRows = j.services.map(function (s) {
          return { service: s.service, hostname: s.hostname, private: s.private, wasPrivate: s.private, applied: s.applied, allowText: s.allow.join(', ') };
        });
        this.accessOpen = true;
      } catch (e) { this.showToast('✗ ' + e.message, false); }
    },
    closeAccess: function () { this.accessOpen = false; },
    saveAccess: async function () {
      if (this.cannotSaveAccess) return;
      this.accessBusy = true; this.accessError = '';
      try {
        var r = await post('/api/access/' + encodeURIComponent(this.accessProject), {
          services: this.accessRows.map(function (s) { return { service: s.service, private: !!s.private, allow: s.allowText }; }),
          up: this.accessUp, confirmPublic: this.accessConfirm,
        });
        if (r.status === 401) { location.assign('/login'); return; }
        var j = await r.json().catch(function () { return {}; });
        if (j.saved) {
          this.accessOpen = false;
          this.showToast((j.ok ? '✓ ' : '✗ ') + 'Access saved for ' + this.accessProject + (this.accessUp ? '' : ' (applies on the next up)') + (j.output ? '\\n' + j.output : ''), !!j.ok, 12000);
          this.load();
        } else this.accessError = j.error || ('HTTP ' + r.status);
      } catch (e) { this.accessError = 'Network error'; } finally { this.accessBusy = false; }
    },
  };
});
`;
