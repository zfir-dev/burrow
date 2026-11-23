// Panel: uptime timeline. A bar per project for the last hour, day or week, built from the
// event history (starts and stops from the CLI and dashboard, health transitions recorded
// by `burrow watch`, or by the dashboard itself while watch isn't running) and what the project
// is doing now; plus the uptime % and incidents.
import { collect } from '../data.js';
import { readPid } from '../../process.js';
import { timelines, WINDOWS } from '../../uptime.js';
import { observe } from '../../health-observer.js';

export const order = 65;
const OBSERVE_MS = 60 * 1000;

// Without `burrow watch`, the dashboard records the health changes it sees (health-observer.js):
// on every refresh of the project list, and once a minute with no browser open.
export async function enrich(projects) {
  try { observe(projects); } catch {}
}
export function start(ctx) {
  const tick = async () => { try { observe((await ctx.collect()).projects); } catch {} };
  const timer = setInterval(tick, OBSERVE_MS);
  const first = setTimeout(tick, 10 * 1000);
  timer.unref?.(); first.unref?.();
  return () => { clearInterval(timer); clearTimeout(first); };
}

export async function route(ctx) {
  if (ctx.method !== 'GET' || ctx.path !== '/api/uptime') return false;
  const window = ctx.url.searchParams.get('window') || '24h';
  if (!WINDOWS[window]) return ctx.json(400, { error: `window must be one of ${Object.keys(WINDOWS).join(', ')}` }) ?? true;
  const data = await collect(ctx.loadConfig());
  const rows = data.projects.filter((p) => !p.builtIn).map((p) => ({
    project: p.project, running: !!p.running, startedAt: p.startedAt, crashed: !p.running && !!readPid(p.project),
  }));
  const now = Date.now();
  const t = timelines(rows, { now, windowMs: WINDOWS[window] });
  ctx.json(200, { window, now, from: now - WINDOWS[window], projects: rows.map((r) => ({ project: r.project, running: r.running, ...t[r.project] })) });
  return true;
}

export const html = {
  toolbar: '<li><button class="secondary outline" @click="openUptime">Uptime</button></li>',
  sections: `
<article x-show="uptimeOpen" class="uptime">
  <header class="logs-head">
    <strong>Uptime</strong>
    <select x-model="uptimeWindow" @change="loadUptime" aria-label="Time window">
      <option value="1h">Last hour</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option>
    </select>
    <span class="spacer"></span>
    <button class="secondary outline" @click="closeUptime">Close</button>
  </header>
  <p class="error" x-show="hasUptimeError" x-text="uptimeError"></p>
  <template x-for="u in uptimeRows" :key="u.project">
    <div class="uptime-row">
      <div class="uptime-name"><strong x-text="u.project"></strong> <small class="muted" x-text="uptimePct(u)"></small></div>
      <div class="uptime-bar" role="img" :aria-label="uptimeAria(u)">
        <template x-for="s in u.segments" :key="s.from">
          <span :class="segClass(s)" :style="segStyle(s)" :title="segTitle(s)"></span>
        </template>
      </div>
      <ul class="uptime-incidents" x-show="hasIncidents(u)">
        <template x-for="i in firstIncidents(u)" :key="i.at">
          <li><small><span class="badge" :class="incidentClass(i)" x-text="i.status"></span> <span x-text="incidentTime(i)"></span> <span class="muted" x-text="i.detail"></span></small></li>
        </template>
      </ul>
    </div>
  </template>
  <p class="uptime-legend"><small><span class="seg seg-up"></span> up <span class="seg seg-degraded"></span> degraded
    <span class="seg seg-down"></span> down <span class="seg seg-stopped"></span> stopped <span class="seg seg-unknown"></span> no data</small></p>
  <p><small class="muted">Health changes come from <code>burrow watch</code> when it runs; without it the dashboard records the crashes and tunnel outages it sees (checked every minute).</small></p>
</article>`,
};

export const css = `
.uptime-row{margin:.6rem 0}
.uptime-name{display:flex;gap:.5rem;align-items:baseline}
.uptime-bar{display:flex;height:14px;border-radius:4px;overflow:hidden;background:var(--pico-muted-border-color)}
.uptime-bar span{display:block;height:100%;min-width:1px}
.seg-up{background:#1f9d55}.seg-degraded{background:#d97706}.seg-down{background:#dc2626}
.seg-stopped{background:#94a3b8}.seg-unknown{background:var(--pico-muted-border-color)}
.uptime-legend .seg{display:inline-block;width:.8rem;height:.6rem;border-radius:2px;margin-left:.5rem;vertical-align:middle}
.uptime-incidents{margin:.3rem 0 0;padding-left:0;list-style:none}.uptime-incidents li{list-style:none;margin:0}
.uptime select{width:auto;margin:0 0 0 .75rem;padding:.2rem 2rem .2rem .6rem;height:auto}
`;

export const js = `
burrowPanel(function () {
  return {
    uptimeOpen: false, uptimeWindow: '24h', uptimeRows: [], uptimeError: '', uptimeNow: 0,
    get hasUptimeError() { return this.uptimeError.length > 0; },
    openUptime: function () { this.uptimeOpen = true; this.loadUptime(); },
    closeUptime: function () { this.uptimeOpen = false; },
    loadUptime: async function () {
      this.uptimeError = '';
      try {
        var j = await getJson('/api/uptime?window=' + encodeURIComponent(this.uptimeWindow));
        this.uptimeRows = j.projects; this.uptimeNow = j.now;
      } catch (e) { this.uptimeError = e.message; }
    },
    onLoad: function () { if (this.uptimeOpen) this.loadUptime(); },
    uptimePct: function (u) { return u.uptimePct === null ? 'no data' : u.uptimePct + '% up'; },
    uptimeAria: function (u) { return u.project + ': ' + this.uptimePct(u); },
    segClass: function (s) { return 'seg-' + s.status; },
    segStyle: function (s) { return { flexGrow: String(s.pct), flexBasis: '0' }; },
    segTitle: function (s) {
      var label = s.status === 'unknown' ? 'no data' : s.status;
      return label + ': ' + new Date(s.from).toLocaleString() + ' to ' + new Date(s.to).toLocaleString() + ' (' + ago(s.to - s.from) + ')';
    },
    hasIncidents: function (u) { return u.incidents.length > 0; },
    firstIncidents: function (u) { return u.incidents.slice(0, 3); },
    incidentClass: function (i) { return i.status === 'down' ? 'bad' : 'warn'; },
    incidentTime: function (i) { return ago(this.uptimeNow - Date.parse(i.at)) + ' ago'; },
  };
});
`;
