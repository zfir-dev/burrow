// Panel: request stats per hostname from Cloudflare analytics (the same GraphQL
// query as `burrow stats`), with a small inline-SVG chart. No chart library.
import { assertLabel } from '../../naming.js';
import { fetchStats, fetchSeries, parseSince } from '../../stats.js';

export const order = 30;
export const WINDOWS = ['1h', '6h', '24h', '7d'];
const CACHE_MS = 60000;
const cache = new Map();

export function clearCache() { cache.clear(); }

export async function projectStats(project, since, cfg) {
  const s = await fetchStats(project, { since }, cfg);
  const { step, series } = await fetchSeries({ cfg, zoneTag: s.zoneTag, hosts: s.hosts, since: s.since, until: s.until });
  const pick = (r) => ({ hostname: r.hostname, requests: r.requests, bytes: r.bytes, classes: r.classes, status: r.status });
  return {
    project: s.project, window: since, since: s.since.toISOString(), until: s.until.toISOString(), sampled: true,
    hostnames: s.rows.map(pick), total: pick({ ...s.total, hostname: 'total' }), step, series,
  };
}

export async function route(ctx) {
  const m = ctx.path.match(/^\/api\/stats\/([^/]+)$/);
  if (ctx.method !== 'GET' || !m) return false;
  const project = m[1];
  try { assertLabel(project, 'project'); } catch { return ctx.json(400, { error: 'bad project' }) ?? true; }
  const since = ctx.url.searchParams.get('since') || '24h';
  if (!WINDOWS.includes(since)) return ctx.json(400, { error: `since must be one of ${WINDOWS.join(', ')}` }) ?? true;
  parseSince(since);
  const key = `${project}|${since}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return ctx.json(200, { ...hit.data, cached: true }) ?? true;
  try {
    const data = await projectStats(project, since, ctx.loadConfig());
    cache.set(key, { at: Date.now(), data });
    ctx.json(200, data);
  } catch (e) {
    ctx.json(502, { error: e.message });
  }
  return true;
}

export const html = {
  rowActions: '<button class="secondary outline" @click="openStats(p)">Stats</button>',
  sections: `
<article x-show="statsOpen" class="stats">
  <header class="logs-head">
    <strong x-text="statsTitle"></strong>
    <span class="spacer"></span>
    <select x-model="statsWindow" @change="loadStats" aria-label="Time window">
      <option value="1h">Last hour</option><option value="6h">Last 6 hours</option>
      <option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option>
    </select>
    <select x-model="statsHost" aria-label="Hostname">
      <option value="">All hostnames</option>
      <template x-for="r in statsRows" :key="r.hostname"><option :value="r.hostname" x-text="r.hostname"></option></template>
    </select>
    <button class="secondary outline" @click="loadStats">Refresh</button>
    <button class="secondary outline" @click="closeStats">Close</button>
  </header>
  <p x-show="statsLoading" aria-busy="true">Loading analytics…</p>
  <p class="error" x-show="hasStatsError" x-text="statsError"></p>
  <div x-show="hasStats">
    <div class="chart-wrap">
      <svg class="chart" viewBox="0 0 600 120" preserveAspectRatio="none" role="img" :aria-label="chartLabel">
        <path class="area" :d="chartArea"></path>
        <path class="line e4" :d="chartLine4"></path>
        <path class="line e5" :d="chartLine5"></path>
      </svg>
      <div class="chart-axis"><small x-text="chartStart"></small><small x-text="chartMax"></small><small x-text="chartEnd"></small></div>
      <small class="legend"><span class="key req"></span> requests <span class="key e4"></span> 4xx <span class="key e5"></span> 5xx · Cloudflare analytics are sampled</small>
    </div>
    <div class="overflow-auto">
    <table class="striped">
      <thead><tr><th>Hostname</th><th>Requests</th><th>Bandwidth</th><th>2xx</th><th>3xx</th><th>4xx</th><th>5xx</th><th>Errors</th></tr></thead>
      <tbody>
        <template x-for="r in statsTable" :key="r.hostname">
          <tr>
            <td x-text="r.hostname"></td><td x-text="fmtNum(r.requests)"></td><td x-text="fmtBytes(r.bytes)"></td>
            <td x-text="fmtNum(r.classes['2xx'])"></td><td x-text="fmtNum(r.classes['3xx'])"></td>
            <td x-text="fmtNum(r.classes['4xx'])"></td><td x-text="fmtNum(r.classes['5xx'])"></td><td x-text="errorRate(r)"></td>
          </tr>
        </template>
      </tbody>
    </table>
    </div>
  </div>
</article>`,
};

export const css = `
.stats select{width:auto;margin:0;padding:.3rem 2rem .3rem .6rem;font-size:.85rem}
.chart-wrap{margin-bottom:1rem}
.chart{width:100%;height:140px;display:block;border-bottom:1px solid var(--pico-muted-border-color)}
.chart .area{fill:rgba(1,114,173,.18);stroke:#0172ad;stroke-width:1.5;vector-effect:non-scaling-stroke}
.chart .line{fill:none;stroke-width:1.5;vector-effect:non-scaling-stroke}
.chart .e4{stroke:#d97706}.chart .e5{stroke:#dc2626}
.chart-axis{display:flex;justify-content:space-between;color:var(--pico-muted-color)}
.legend{color:var(--pico-muted-color)}
.key{display:inline-block;width:.7rem;height:.7rem;border-radius:2px;vertical-align:middle;margin-left:.5rem}
.key.req{background:#0172ad}.key.e4{background:#d97706}.key.e5{background:#dc2626}
`;

export const js = `
burrowPanel(function () {
  var W = 600, H = 120;
  function path(points) { return points.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '); }
  return {
    statsOpen: false, statsProject: '', statsWindow: '24h', statsHost: '', statsLoading: false, statsError: '', stats: null,

    get statsTitle() { return 'Stats · ' + this.statsProject; },
    get hasStats() { return !!this.stats && !this.statsLoading; },
    get hasStatsError() { return this.statsError.length > 0; },
    get statsRows() { return this.stats ? this.stats.hostnames : []; },
    get statsTable() {
      if (!this.stats) return [];
      var rows = this.stats.hostnames.slice();
      if (rows.length > 1) rows.push(this.stats.total);
      return rows;
    },
    get buckets() { return this.stats ? (this.stats.series[this.statsHost || 'all'] || []) : []; },
    get chartPeak() { var m = 0; this.buckets.forEach(function (b) { if (b.requests > m) m = b.requests; }); return m; },
    chartPoints: function (key) {
      var b = this.buckets, n = b.length, max = this.chartPeak || 1;
      return b.map(function (x, i) { return [n > 1 ? i * W / (n - 1) : 0, H - (x[key] / max) * (H - 4)]; });
    },
    get chartArea() {
      var pts = this.chartPoints('requests');
      if (!pts.length) return '';
      return path([[0, H]].concat(pts).concat([[W, H]])) + ' Z';
    },
    get chartLine4() { return path(this.chartPoints('e4xx')); },
    get chartLine5() { return path(this.chartPoints('e5xx')); },
    fmtTime: function (t) {
      var d = new Date(t);
      return this.statsWindow === '7d' ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },
    get chartStart() { return this.buckets.length ? this.fmtTime(this.buckets[0].t) : ''; },
    get chartEnd() { return this.buckets.length ? this.fmtTime(this.buckets[this.buckets.length - 1].t) : ''; },
    get chartMax() { return 'peak ' + this.fmtNum(this.chartPeak) + ' req / ' + (this.stats && this.stats.step >= 3600000 ? 'hour' : '15 min'); },
    get chartLabel() { return 'Requests over time, ' + this.chartMax; },
    fmtNum: function (n) { return Number(n || 0).toLocaleString('en-US'); },
    fmtBytes: function (n) {
      var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, v = Number(n) || 0;
      while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
      return i ? v.toFixed(v < 10 ? 2 : 1) + ' ' + u[i] : v + ' B';
    },
    errorRate: function (r) {
      if (!r.requests) return '—';
      return ((r.classes['4xx'] + r.classes['5xx']) / r.requests * 100).toFixed(1) + '%';
    },
    openStats: function (p) { this.statsProject = p.project; this.statsHost = ''; this.stats = null; this.statsOpen = true; this.loadStats(); },
    closeStats: function () { this.statsOpen = false; },
    loadStats: async function () {
      this.statsLoading = true; this.statsError = '';
      try {
        this.stats = await getJson('/api/stats/' + encodeURIComponent(this.statsProject) + '?since=' + encodeURIComponent(this.statsWindow));
        var self = this;
        if (this.statsHost && !this.stats.hostnames.some(function (r) { return r.hostname === self.statsHost; })) this.statsHost = '';
      } catch (e) { this.stats = null; this.statsError = e.message; } finally { this.statsLoading = false; }
    },
  };
});
`;
