// Panel: doctor. Runs `burrow doctor --json --all` (config, token, zone, permissions,
// cloudflared and every remembered project's local services) and shows each check with a
// pass / warning / fail badge and, for problems, what to do about it.
export const order = 85;

// The last line of the CLI output that is the JSON report.
export function parseReport(output) {
  const lines = String(output || '').split('\n').reverse();
  for (const l of lines) {
    if (!l.startsWith('{"counts"')) continue;
    try { return JSON.parse(l); } catch {}
  }
  return null;
}

// [{ title, checks: [...] }] in report order.
export function groupChecks(checks) {
  const out = [];
  for (const c of checks || []) {
    let g = out[out.length - 1];
    if (!g || g.title !== c.section) { g = { title: c.section, checks: [] }; out.push(g); }
    g.checks.push(c);
  }
  return out;
}

let last = null;

export async function route(ctx) {
  if (ctx.path !== '/api/doctor') return false;
  if (ctx.method === 'GET') return ctx.json(200, last || { ran: false }) ?? true;
  if (ctx.method !== 'POST') return false;
  const body = await ctx.readJson();
  if (!body) return ctx.json(400, { error: 'invalid JSON' }) ?? true;
  const args = ['doctor', '--json', '--all', ...(body.offline === true ? ['--offline'] : [])];
  const r = await ctx.withBusy('(doctor)', async () => {
    const run = await ctx.runCli(args, 60000);
    const report = parseReport(run.output);
    if (!report) return { ok: false, error: 'doctor did not finish', output: run.output.slice(-2000) };
    return { ok: true, ran: true, at: new Date().toISOString(), offline: body.offline === true, counts: report.counts, groups: groupChecks(report.checks) };
  });
  if (!r) return ctx.json(409, { error: 'doctor is already running' }) ?? true;
  if (r.ok) last = r;
  ctx.json(r.ok ? 200 : 500, r);
  return true;
}

export const html = {
  toolbar: '<li><button class="secondary outline" @click="openDoctor">Doctor</button></li>',
  sections: `
<article x-show="doctorOpen" class="doctor">
  <header class="logs-head">
    <strong>Doctor</strong><small class="muted" x-text="doctorSummary"></small>
    <span class="spacer"></span>
    <label><input type="checkbox" role="switch" x-model="doctorOffline"> Skip Cloudflare API checks</label>
    <button class="secondary outline" :aria-busy="doctorBusy" :disabled="doctorBusy" @click="runDoctor">Run checks</button>
    <button class="secondary outline" @click="closeDoctor">Close</button>
  </header>
  <p class="error" x-show="hasDoctorError" x-text="doctorError"></p>
  <p x-show="doctorNeverRan"><small class="muted">Checks the config, the API token and its permissions, the zone, cloudflared and the local services of every remembered project.</small></p>
  <template x-for="g in doctorGroups" :key="g.title">
    <section class="doctor-group">
      <h6 x-text="g.title"></h6>
      <ul>
        <template x-for="(c, i) in g.checks" :key="i">
          <li :class="c.status">
            <span class="badge" :class="doctorBadgeClass(c)" x-text="doctorBadge(c)"></span>
            <strong x-text="c.label"></strong> <small class="muted" x-text="c.detail"></small>
            <div class="fix" x-show="hasFix(c)"><small><strong>Fix:</strong> <span x-text="c.fix"></span></small></div>
          </li>
        </template>
      </ul>
    </section>
  </template>
</article>`,
};

export const css = `
.doctor-group h6{margin:.8rem 0 .3rem}.doctor-group ul{list-style:none;padding:0;margin:0}
.doctor-group li{list-style:none;padding:.25rem 0;border-bottom:1px solid var(--pico-muted-border-color)}
.doctor-group .badge{min-width:3.6rem;text-align:center;margin-right:.4rem}
.doctor-group .fix{margin:.15rem 0 0 4.1rem;color:var(--pico-color)}
.doctor-group li.fail .fix{color:#dc2626}.doctor-group li.warn .fix{color:#b45309}
`;

export const js = `
burrowPanel(function () {
  var BADGE = { pass: 'pass', warn: 'warning', fail: 'fail', skip: 'skipped' };
  var CLASS = { pass: 'ok', warn: 'warn', fail: 'bad', skip: '' };
  return {
    doctorOpen: false, doctorBusy: false, doctorOffline: false, doctorError: '', doctor: { ran: false, groups: [] },
    get doctorGroups() { return this.doctor.groups || []; },
    get hasDoctorError() { return this.doctorError.length > 0; },
    get doctorNeverRan() { return !this.doctor.ran && !this.doctorBusy; },
    get doctorSummary() {
      var c = this.doctor.counts;
      if (!c) return '';
      return c.pass + ' passed · ' + c.warn + ' warning(s) · ' + c.fail + ' failed' + (c.skip ? ' · ' + c.skip + ' skipped' : '') + ' · ' + ago(Date.now() - Date.parse(this.doctor.at)) + ' ago';
    },
    doctorBadge: function (c) { return BADGE[c.status] || c.status; },
    doctorBadgeClass: function (c) { return CLASS[c.status] || ''; },
    hasFix: function (c) { return !!c.fix; },
    openDoctor: async function () {
      this.doctorOpen = true;
      try { var j = await getJson('/api/doctor'); if (j.ran) this.doctor = j; else this.runDoctor(); } catch (e) { this.doctorError = e.message; }
    },
    closeDoctor: function () { this.doctorOpen = false; },
    runDoctor: async function () {
      this.doctorBusy = true; this.doctorError = '';
      try {
        var r = await post('/api/doctor', { offline: this.doctorOffline });
        if (r.status === 401) { location.assign('/login'); return; }
        var j = await r.json().catch(function () { return {}; });
        if (r.ok) this.doctor = j; else this.doctorError = j.error || ('HTTP ' + r.status);
      } catch (e) { this.doctorError = 'Network error'; } finally { this.doctorBusy = false; }
    },
  };
});
`;
