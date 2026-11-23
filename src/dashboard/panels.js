// Dashboard panels: optional features that plug into the dashboard without
// touching the core files. Each file in ./panels/*.js is one panel; see
// ./panels/README.md for the interface.
import { readdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = fileURLToPath(new URL('./panels/', import.meta.url));

// In-process events from panels (e.g. "a tunnel.yml was saved from the UI").
// Shape: { action, project, ok, detail }. The event history panel records them.
export const events = new EventEmitter();
events.setMaxListeners(50);

// Places in the dashboard page a panel can add HTML to.
export const SLOTS = [
  'toolbarMain', // always-visible items in the top bar (status, primary or contextual buttons)
  'toolbar', // buttons that open a panel; listed in the top bar's "More" menu
  'headLead', 'rowLead', // a leading <th>/<td> on the project table
  'rowBadges', // after the project name
  'hostExtras', // after each hostname link (h and p in scope)
  'localExtras', // under the Local state
  'headCols', 'rowCols', // extra <th>/<td> before the actions column
  'rowActions', // buttons at the start of each row's actions
  'sections', // <article>s under the table
  'dialogs', // <dialog>s at the end of <body>
];

let loaded = null;
export function loadPanels(dir = DIR) {
  if (dir !== DIR) return importPanels(dir);
  if (!loaded) loaded = importPanels(DIR);
  return loaded;
}

async function importPanels(dir) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => /^[a-z0-9-]+\.js$/.test(f)).sort(); } catch {}
  const out = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(dir + f).href);
    out.push({ id: f.slice(0, -3), ...mod });
  }
  return sortPanels(out);
}

export const sortPanels = (panels) =>
  [...panels].sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || String(a.id).localeCompare(String(b.id)));

export const slot = (panels, name) => panels.map((p) => p.html?.[name] || '').join('');
export const panelJs = (panels) => panels.map((p) => (p.js ? `// panel: ${p.id}\n${p.js}\n` : '')).join('');
export const panelCss = (panels) => panels.map((p) => p.css || '').join('\n');
export const panelVendor = (panels) => Object.assign({}, ...panels.map((p) => p.vendor || {}));
