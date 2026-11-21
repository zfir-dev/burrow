# Dashboard panels

Every `*.js` file in this directory is loaded by the dashboard at start-up (sorted by
`order`, then file name). A panel adds a feature without editing the core files, so
features can be developed and merged independently. All exports are optional:

```js
export const order = 50;

// HTML added to the page. Slot names: see SLOTS in ../panels.js.
export const html = { toolbar: '<li>…</li>', sections: '<article>…</article>' };

// Browser JS, served in /panels.js after /app.js. It registers a mixin that is merged
// into the Alpine "dashboard" component. init() runs once; onLoad(data) runs after
// every /api/tunnels refresh. Helpers from app.js: post(url, body), getJson(url), ago(ms).
export const js = `burrowPanel(function () { return { … }; });`;

export const css = '.my-panel{…}';

// Extra vendored files: URL -> { pkg: '<npm package path>', type }.
export const vendor = { '/vendor/thing.js': { pkg: 'thing/dist/thing.min.js', type: 'text/javascript; charset=utf-8' } };

// Add fields to each project row of GET /api/tunnels.
export async function enrich(projects, ctx) {}

// Handle a request. Runs only for signed-in sessions, and POSTs already carry the
// X-Burrow CSRF header. Return true when the request was answered.
export async function route(ctx) { return false; }
```

`ctx` has `req`, `res`, `method`, `path`, `url` (URL), `json(status, obj)`, `send(status, body, type, headers)`,
`readJson(limit)`, `runCli(args)`, `withBusy(project, fn)` (409 when the project is busy), `clientIp`,
`loadConfig()`, `invalidate()` (drop the cached Cloudflare state), `events`, `log`.

Every panel uses the same CSP-safe Alpine build: no inline scripts, no `eval`, and
expressions in the HTML stay simple (property reads and method calls).
