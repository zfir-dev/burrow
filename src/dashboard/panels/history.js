// Panel: event history. Shows the actions recorded in ~/.local/state/burrow/history/
// events.jsonl by the CLI (including commands the dashboard runs, tagged "dashboard")
// and by other panels (e.g. a tunnel.yml saved from the form).
import { assertLabel } from '../../naming.js';
import { events } from '../panels.js';
import { readEvents, recordEvent, SOURCES } from '../../history.js';

export const order = 60;

// In-process dashboard actions that don't go through the CLI.
events.on('event', (e) => recordEvent({ ...e, source: 'dashboard' }));

export async function route(ctx) {
  if (ctx.method !== 'GET' || ctx.path !== '/api/history') return false;
  const q = ctx.url.searchParams;
  const project = q.get('project') || undefined;
  const source = q.get('source') || undefined;
  if (project) { try { assertLabel(project, 'project'); } catch { return ctx.json(400, { error: 'bad project' }) ?? true; } }
  if (source && !SOURCES.includes(source)) return ctx.json(400, { error: `source must be one of ${SOURCES.join(', ')}` }) ?? true;
  const limit = Math.min(1000, Math.max(1, parseInt(q.get('limit') || '200', 10) || 200));
  ctx.json(200, { events: readEvents({ limit, project, source }) });
  return true;
}

export const html = {
  toolbar: '<li><button class="secondary outline" @click="openHistory">History</button></li>',
  sections: `
<article x-show="historyOpen" class="history">
  <header class="logs-head">
    <strong>Event history</strong>
    <small class="muted" x-text="historyCount"></small>
    <span class="spacer"></span>
    <select x-model="historyProject" @change="loadHistory" aria-label="Project">
      <option value="">All projects</option>
      <template x-for="p in projects" :key="p.project"><option :value="p.project" x-text="p.project"></option></template>
    </select>
    <select x-model="historySource" @change="loadHistory" aria-label="Source">
      <option value="">Any source</option><option value="cli">CLI</option><option value="dashboard">Dashboard</option><option value="boot">Boot</option>
    </select>
    <button class="secondary outline" @click="loadHistory">Refresh</button>
    <button class="secondary outline" @click="closeHistory">Close</button>
  </header>
  <p class="error" x-show="hasHistoryError" x-text="historyError"></p>
  <p x-show="historyEmpty"><small class="muted">Nothing recorded yet.</small></p>
  <div class="overflow-auto" x-show="hasHistory">
  <table class="striped">
    <thead><tr><th>When</th><th>Action</th><th>Project</th><th>Source</th><th>Result</th><th>Took</th><th>Details</th></tr></thead>
    <tbody>
      <template x-for="e in historyEvents" :key="e.key">
        <tr>
          <td :title="e.at" x-text="eventTime(e)"></td>
          <td><code x-text="e.action"></code></td>
          <td x-text="eventProject(e)"></td>
          <td><span class="badge" :class="sourceClass(e)" x-text="e.source"></span></td>
          <td><span class="badge" :class="resultClass(e)" x-text="resultText(e)"></span></td>
          <td x-text="eventTook(e)"></td>
          <td><small x-text="eventDetail(e)"></small></td>
        </tr>
      </template>
    </tbody>
  </table>
  </div>
</article>`,
};

export const css = `
.history select{width:auto;margin:0;padding:.3rem 2rem .3rem .6rem;font-size:.85rem}
.badge.src-dashboard{color:#0172ad;border-color:#0172ad}.badge.src-boot{color:#7c3aed;border-color:#7c3aed}
`;

export const js = `
burrowPanel(function () {
  return {
    historyOpen: false, historyEvents: [], historyProject: '', historySource: '', historyError: '', historyLoaded: false,
    get hasHistory() { return this.historyEvents.length > 0; },
    get historyEmpty() { return this.historyLoaded && !this.historyEvents.length && !this.historyError; },
    get hasHistoryError() { return this.historyError.length > 0; },
    get historyCount() { return this.historyLoaded ? this.historyEvents.length + ' events' : ''; },
    openHistory: function () { this.historyOpen = true; this.loadHistory(); },
    closeHistory: function () { this.historyOpen = false; },
    loadHistory: async function () {
      this.historyError = '';
      var q = new URLSearchParams({ limit: '300' });
      if (this.historyProject) q.set('project', this.historyProject);
      if (this.historySource) q.set('source', this.historySource);
      try {
        var list = (await getJson('/api/history?' + q.toString())).events || [];
        list.forEach(function (e, i) { e.key = e.at + '|' + i; });
        this.historyEvents = list;
      } catch (e) { this.historyEvents = []; this.historyError = e.message; } finally { this.historyLoaded = true; }
    },
    eventTime: function (e) {
      var d = new Date(e.at);
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },
    eventProject: function (e) { return e.project || '—'; },
    eventDetail: function (e) { return e.detail || ''; },
    eventTook: function (e) { return e.durationMs >= 0 ? (e.durationMs < 1000 ? e.durationMs + ' ms' : (e.durationMs / 1000).toFixed(1) + ' s') : ''; },
    sourceClass: function (e) { return 'src-' + e.source; },
    resultClass: function (e) { return e.ok ? 'ok' : 'bad'; },
    resultText: function (e) { return e.ok ? 'ok' : 'failed'; },
  };
});
`;
