// Panel: hook results. `burrow up`/`down` record each hook run (pre_up, post_up, pre_down,
// post_down) in hooks/results.jsonl: when, project, hook, ok or the reason it failed, and
// how long it took. The command and its output are never recorded (they can hold secrets).
// Rows whose latest hook run failed get a badge; the Hooks section lists recent runs.
import { HOOK_NAMES, readHookResults } from '../../hooks.js';
import { assertLabel } from '../../naming.js';

export const order = 70;

export async function enrich(projects) {
  const latest = new Map();
  for (const r of readHookResults({ limit: 500 })) if (!latest.has(r.project)) latest.set(r.project, r);
  for (const p of projects) {
    const r = latest.get(p.project);
    if (r) p.lastHook = { hook: r.hook, ok: r.ok, at: r.at, error: r.error || null };
  }
}

export async function route(ctx) {
  if (ctx.method !== 'GET' || ctx.path !== '/api/hooks') return false;
  const project = ctx.url.searchParams.get('project') || undefined;
  if (project) { try { assertLabel(project, 'project'); } catch { return ctx.json(400, { error: 'bad project' }) ?? true; } }
  const limit = Math.min(500, Math.max(1, Number(ctx.url.searchParams.get('limit')) || 100));
  ctx.json(200, { hooks: HOOK_NAMES, results: readHookResults({ limit, project }) });
  return true;
}

export const html = {
  toolbar: '<li><button class="secondary outline" @click="openHooks">Hooks</button></li>',
  rowBadges: '<span class="badge bad" x-show="hookFailed(p)" :title="hookFailTitle(p)">hook failed</span>',
  sections: `
<article x-show="hooksOpen" class="hooks">
  <header class="logs-head">
    <strong>Hook runs</strong><small class="muted">pre_up, post_up, pre_down, post_down from tunnel.yml</small>
    <span class="spacer"></span>
    <button class="secondary outline" @click="loadHooks">Refresh</button>
    <button class="secondary outline" @click="closeHooks">Close</button>
  </header>
  <p x-show="noHookRuns"><small class="muted">No hook runs recorded yet. Add <code>hooks:</code> to a tunnel.yml (see docs/hooks.md).</small></p>
  <table x-show="hasHookRuns" class="hook-runs">
    <thead><tr><th>When</th><th>Project</th><th>Hook</th><th>Result</th><th>Took</th><th>From</th></tr></thead>
    <tbody>
      <template x-for="r in hookRuns" :key="r.key">
        <tr>
          <td><small x-text="hookWhen(r)"></small></td>
          <td x-text="r.project"></td>
          <td><code x-text="hookName(r)"></code></td>
          <td><span class="badge" :class="hookClass(r)" x-text="hookResult(r)"></span> <small class="muted" x-text="r.error"></small></td>
          <td><small x-text="hookTook(r)"></small></td>
          <td><small x-text="r.source"></small></td>
        </tr>
      </template>
    </tbody>
  </table>
</article>`,
};

export const css = `
.hook-runs{font-size:.875rem}.hook-runs td{white-space:normal}
`;

export const js = `
burrowPanel(function () {
  return {
    hooksOpen: false, hookRuns: [], hooksLoaded: false,
    get hasHookRuns() { return this.hookRuns.length > 0; },
    get noHookRuns() { return this.hooksLoaded && this.hookRuns.length === 0; },
    hookFailed: function (p) { return !!(p.lastHook && !p.lastHook.ok); },
    hookFailTitle: function (p) { return p.lastHook ? p.lastHook.hook + ': ' + (p.lastHook.error || 'failed') : ''; },
    openHooks: function () { this.hooksOpen = true; this.loadHooks(); },
    closeHooks: function () { this.hooksOpen = false; },
    loadHooks: async function () {
      try {
        var j = await getJson('/api/hooks?limit=100');
        j.results.forEach(function (r, i) { r.key = r.at + '|' + i; });
        this.hookRuns = j.results; this.hooksLoaded = true;
      } catch (e) { this.showToast('✗ ' + e.message, false); }
    },
    hookWhen: function (r) { return ago(Date.now() - Date.parse(r.at)) + ' ago'; },
    hookName: function (r) { return r.hook + (r.background ? ' (background)' : ''); },
    hookClass: function (r) { return r.ok ? 'ok' : 'bad'; },
    hookResult: function (r) { return r.ok ? (r.background ? 'started' : 'ok') : 'failed'; },
    hookTook: function (r) { return r.durationMs < 1000 ? r.durationMs + ' ms' : (r.durationMs / 1000).toFixed(1) + ' s'; },
  };
});
`;
