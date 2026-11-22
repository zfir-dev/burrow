import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { configPath, stateDir } from './config.js';
import { parseProject } from './project.js';
import { readMeta, saveMeta } from './process.js';

const log = (...a) => console.error(...a); // stdout may carry the bundle

// Keep only known tunnel.yml fields, so nothing else (secrets included) is ever copied.
export function cleanProject(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('project entry must be a mapping');
  const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
  const out = pick(raw, ['project', 'autostart']);
  out.services = (Array.isArray(raw.services) ? raw.services : []).map((s) => {
    const svc = pick(s || {}, ['name', 'root', 'url', 'originRequest']);
    if (Array.isArray(s?.paths) && s.paths.length) svc.paths = s.paths.map((p) => pick(p || {}, ['path', 'url', 'originRequest']));
    return svc;
  });
  parseProject(YAML.stringify(out), `project ${out.project}`); // validate
  return out;
}

function rememberedProjects() {
  let names = [];
  try { names = readdirSync(stateDir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch {}
  return names.sort().map((n) => ({ name: n, meta: readMeta(n) })).filter(({ meta }) => meta?.file && !meta.share && existsSync(meta.file));
}

export function buildBundle(filter = []) {
  const projects = [];
  for (const { name, meta } of rememberedProjects()) {
    if (filter.length && !filter.includes(name)) continue;
    projects.push(cleanProject(YAML.parse(readFileSync(meta.file, 'utf8'))));
  }
  const missing = filter.filter((f) => !projects.some((p) => p.project === f));
  if (missing.length) throw new Error(`Unknown project(s): ${missing.join(', ')}`);
  return { burrow: 'projects', version: 1, exportedAt: new Date().toISOString(), projects };
}

export async function exportProjects(file, opts = {}) {
  const filter = (opts.project || '').split(',').map((s) => s.trim()).filter(Boolean);
  const bundle = buildBundle(filter);
  const asJson = opts.json || /\.json$/i.test(file || '');
  const text = asJson
    ? JSON.stringify(bundle, null, 2) + '\n'
    : '# burrow project export. Contains tunnel.yml settings only, no tokens or passwords.\n' + YAML.stringify(bundle, { lineWidth: 0 });
  if (!file || file === '-') { process.stdout.write(text); return bundle; }
  writeFileSync(resolve(file), text);
  log(`Exported ${bundle.projects.length} project(s) to ${resolve(file)}: ${bundle.projects.map((p) => p.project).join(', ')}`);
  return bundle;
}

export const defaultImportDir = () => join(dirname(configPath()), 'projects');

// A parsed, checked export bundle (YAML or JSON text).
export function parseBundle(text, source = 'the file') {
  let bundle;
  try { bundle = YAML.parse(String(text)); } catch (e) { throw new Error(`${source} is not valid YAML/JSON: ${e.message}`); }
  if (bundle?.burrow !== 'projects' || bundle.version !== 1 || !Array.isArray(bundle.projects)) {
    throw new Error(`${source} is not a burrow export (expected "burrow: projects" and "version: 1")`);
  }
  return bundle;
}

// What importing would do, per project: { project, dest, status: new | exists | known,
// knownAt, proj, error }. "exists": dest is already there; "known": the project is
// remembered at another path. Both need force to be replaced.
export function planImport(bundle, opts = {}) {
  const dir = resolve(opts.dir || defaultImportDir());
  return bundle.projects.map((raw, i) => {
    let proj;
    try { proj = cleanProject(raw); } catch (e) { return { project: String(raw?.project ?? `#${i + 1}`), status: 'invalid', error: e.message }; }
    const dest = join(dir, `${proj.project}.tunnel.yml`);
    const meta = readMeta(proj.project);
    const known = meta?.file && existsSync(meta.file) && resolve(meta.file) !== dest;
    const status = known ? 'known' : existsSync(dest) ? 'exists' : 'new';
    return { project: proj.project, dest, status, ...(known ? { knownAt: meta.file } : {}), proj };
  });
}

// Write one planned entry (see planImport).
export function writeImported(p) {
  const meta = readMeta(p.project);
  mkdirSync(dirname(p.dest), { recursive: true });
  writeFileSync(p.dest, `# imported by burrow on ${new Date().toISOString()}\n` + YAML.stringify(p.proj, { lineWidth: 0 }));
  saveMeta(p.project, { ...(meta || {}), project: p.project, file: p.dest });
}

export async function importProjects(file, opts = {}) {
  const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(file), 'utf8');
  const bundle = parseBundle(text, file);
  const results = { written: [], skipped: [] };
  for (const p of planImport(bundle, opts)) {
    if (p.status === 'invalid') throw new Error(p.error);
    const { proj, dest } = p;
    const meta = readMeta(proj.project);
    const known = p.status === 'known';
    if (!opts.force && p.status !== 'new') {
      log(`skip ${proj.project}: already ${known ? `known at ${meta.file}` : `at ${dest}`} (use --force to replace)`);
      results.skipped.push(proj.project);
      continue;
    }
    if (opts.dryRun) { log(`[dry-run] would write ${dest}`); results.written.push(proj.project); continue; }
    writeImported(p);
    log(`imported ${proj.project} -> ${dest}`);
    results.written.push(proj.project);
  }
  log(`${results.written.length} imported, ${results.skipped.length} skipped. Bring one up with: burrow up <project>`);
  return results;
}
