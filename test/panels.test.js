import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'burrow-panels-'));
process.env.BURROW_STATE_DIR = join(dir, 'state');
process.env.BURROW_CONFIG = join(dir, 'none.env');

const { renderApp, APP_HTML, APP_JS } = await import('../src/dashboard/ui.js');
const { loadPanels, sortPanels, SLOTS, panelJs } = await import('../src/dashboard/panels.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('every slot renders where it belongs, and the base page has none left over', () => {
  const html = Object.fromEntries(SLOTS.map((s) => [s, `<!--${s}-->`]));
  const page = renderApp([{ id: 'demo', html }]);
  for (const s of SLOTS) assert.ok(page.includes(`<!--${s}-->`), s);
  assert.ok(page.indexOf('<!--headLead-->') < page.indexOf('<th>Project</th>'));
  // Panel row actions are items of the row's "⋯" menu, listed before Destroy.
  const menu = page.indexOf('class="row-menu"');
  assert.ok(page.indexOf('openLogs(p)') < menu);
  assert.ok(menu < page.indexOf('<!--rowActions-->') && page.indexOf('<!--rowActions-->') < page.indexOf('askDestroy(p)'));
  assert.ok(page.indexOf('<!--sections-->') < page.indexOf('</main>'));
  assert.match(page, /src="\/panels\.js"/);
  assert.match(page, /href="\/panels\.css"/);
  assert.ok(page.indexOf('/app.js') < page.indexOf('/panels.js'), 'panels.js loads after app.js');
  assert.ok(page.indexOf('/panels.js') < page.indexOf('/vendor/alpine.min.js'), 'and before Alpine starts');
  assert.doesNotMatch(APP_HTML, /\$\{|<!--/);
});

test('the project table fits narrow screens: compact cells, a row menu, cards on small screens', async () => {
  const { APP_CSS } = await import('../src/dashboard/ui.js');
  assert.doesNotMatch(APP_HTML, /overflow-auto/, 'no sideways scrolling that would clip the row menu');
  assert.match(APP_HTML, /<details class="row-menu">[\s\S]*askDestroy\(p\)[\s\S]*<\/details>/);
  for (const col of ['col-project', 'col-hosts', 'col-local', 'col-conn', 'col-uptime', 'col-actions']) assert.ok(APP_HTML.includes(col), col);
  assert.match(APP_HTML, /:title="h"/, 'cut-off hostnames show in full on hover');
  assert.match(APP_CSS, /@media \(max-width:1239px\)\{table\.projects \.col-uptime\{display:none\}\}/);
  assert.match(APP_CSS, /@media \(max-width:1179px\)\{[\s\S]*table\.projects thead\{display:none\}/);
  assert.match(APP_JS, /details\.row-menu\[open\]/, 'menus close on outside click and Escape');
});

test('panels sort by order then id; app.js merges mixins and hooks', () => {
  assert.deepEqual(sortPanels([{ id: 'b' }, { id: 'a', order: 60 }, { id: 'c', order: 10 }]).map((p) => p.id), ['c', 'b', 'a']);
  assert.match(panelJs([{ id: 'x', js: 'burrowPanel(f);' }, { id: 'y' }]), /\/\/ panel: x\nburrowPanel\(f\);/);
  assert.match(APP_JS, /function burrowPanel/);
  assert.match(APP_JS, /hooks\.onLoad\.forEach/);
});

test('the real panels directory loads', async () => {
  const list = await loadPanels();
  assert.ok(Array.isArray(list));
  for (const p of list) assert.match(p.id, /^[a-z0-9-]+$/);
});

test('HTTP: panel routes, assets and enrich sit behind login and the CSRF header', async () => {
  const seen = [];
  const demo = {
    id: 'demo',
    html: { toolbar: '<li id="demo-toolbar"></li>' },
    js: 'burrowPanel(function () { return { demo: 1 }; });',
    css: '.demo{color:red}',
    vendor: { '/vendor/demo.js': { pkg: '@alpinejs/csp/dist/cdn.min.js', type: 'text/javascript; charset=utf-8' } },
    enrich: async (projects) => { projects.forEach((p) => { p.demo = true; }); seen.push('enrich'); },
    route: async (ctx) => {
      if (ctx.path === '/api/demo' && ctx.method === 'GET') return ctx.json(200, { hi: 1 }) ?? true;
      if (ctx.path === '/api/demo' && ctx.method === 'POST') {
        const body = await ctx.readJson();
        const r = await ctx.withBusy('acme-shop', async () => {
          const again = await ctx.withBusy('acme-shop', async () => 'inner');
          return { again };
        });
        ctx.json(200, { body, r });
        return true;
      }
      return false;
    },
  };
  const d = await startDashboard({ panels: [demo] });
  try {
    assert.equal((await fetch(`${d.base}/api/demo`)).status, 401);
    assert.equal((await fetch(`${d.base}/panels.js`, { redirect: 'manual' })).status, 303);
    assert.deepEqual(await (await d.get('/api/demo')).json(), { hi: 1 });
    assert.equal((await fetch(`${d.base}/api/demo`, { method: 'POST', headers: { cookie: d.cookie } })).status, 403);
    const r = await d.post('/api/demo', { a: 1 });
    assert.deepEqual(await r.json(), { body: { a: 1 }, r: { again: null } });
    assert.match(await (await d.get('/panels.js')).text(), /demo: 1/);
    assert.match(await (await d.get('/panels.css')).text(), /\.demo/);
    assert.match(await (await d.get('/')).text(), /id="demo-toolbar"/);
    assert.equal((await fetch(`${d.base}/vendor/demo.js`)).status, 200);
    writeFileSync(join(dir, 'state.marker'), '');
    assert.equal((await d.get('/api/tunnels')).status, 200);
    assert.deepEqual(seen, ['enrich']);
    assert.equal((await d.get('/api/nope')).status, 404);
  } finally { await d.close(); }
});
