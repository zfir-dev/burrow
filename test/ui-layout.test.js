import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers/cli.js';

const sb = sandbox({});
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
const { startDashboard } = await import('./helpers/dash.js');
const { SLOTS } = await import('../src/dashboard/panels.js');
test.after(async () => { await sb.cleanup(); });

// The top bar must fit on one row at 1280px with every panel loaded (checked in a browser
// at 1280 and 1440); these assertions keep the structure that makes that possible.
test('HTTP: panel buttons sit in the top bar "More" menu; primary items stay visible', async () => {
  assert.ok(SLOTS.includes('toolbarMain') && SLOTS.includes('toolbar'));
  const d = await startDashboard();
  try {
    const html = await (await d.get('/')).text();
    const nav = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    const start = nav.indexOf('<details class="row-menu toolbar-more">');
    assert.ok(start > 0, 'More menu present');
    const more = nav.slice(start, nav.indexOf('</details>', start));
    const outside = nav.slice(0, start) + nav.slice(nav.indexOf('</details>', start));
    for (const label of ['Shares', 'History', 'Uptime', 'Alerts', 'Hooks', 'Cleanup', 'Doctor', 'Backup', 'Sessions']) {
      assert.match(more, new RegExp(`>${label}</button>`), `${label} in More`);
      assert.doesNotMatch(outside, new RegExp(`>${label}</button>`), `${label} not in the bar`);
    }
    for (const re of [/live-status/, />New project</, /bulkUp/, /update-notice/, />All logs</, />Refresh</, />Sign out</]) {
      assert.match(outside, re);
      assert.doesNotMatch(more, re);
    }
    const css = await (await d.get('/app.css')).text();
    const page = html + css;
    assert.match(page, /td\.col-project\{white-space:normal\}/, 'badges wrap under the name');
    assert.match(page, /@media \(min-width:1180px\)\{header nav,header nav ul:last-child\{flex-wrap:nowrap\}\}/);
  } finally { await d.close(); }
});
