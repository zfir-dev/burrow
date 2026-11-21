import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import YAML from 'yaml';
import { loadConfig } from './config.js';
import { parseProject, hostnames } from './project.js';

// "3100" -> http://localhost:3100, "host:8080" -> http://host:8080, URLs unchanged.
export function toUrl(value) {
  const v = String(value ?? '').trim();
  if (/^\d+$/.test(v)) return `http://localhost:${v}`;
  if (/^[a-z0-9.-]+:\d+$/i.test(v)) return `http://${v}`;
  return v;
}

export function slug(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// "name=target" -> [name, url]
export function parsePair(spec, flag) {
  const i = String(spec).indexOf('=');
  if (i <= 0 || i === spec.length - 1) throw new Error(`${flag} must look like name=port-or-url, got "${spec}"`);
  return [spec.slice(0, i).trim(), toUrl(spec.slice(i + 1))];
}

export function buildDoc({ project, app, paths = [], services = [] }) {
  const doc = { project, services: [] };
  if (app) {
    const svc = { name: 'app', url: toUrl(app) };
    if (paths.length) svc.paths = paths.map(([path, url]) => ({ path, url: toUrl(url) }));
    doc.services.push(svc);
  } else if (paths.length) {
    throw new Error('Paths need an app service (--app).');
  }
  for (const [name, url] of services) doc.services.push({ name: slug(name), url: toUrl(url) });
  return doc;
}

// Render and validate; throws with the same errors `burrow up` would give.
export function renderYaml(doc) {
  const text = '# burrow tunnel config (see the burrow README for the format)\n' + YAML.stringify(doc, { lineWidth: 0 });
  parseProject(text, 'generated tunnel.yml');
  return text;
}

export function readlineAsk(rl) {
  return async (question, def = '') => {
    const answer = (await rl.question(def ? `${question} [${def}]: ` : `${question}: `)).trim();
    return answer || def;
  };
}

export async function promptDoc(ask, defaults) {
  const project = slug(await ask('Project name', defaults.project));
  const app = await ask('App port or URL (root hostname, empty for none)', defaults.app);
  const paths = [];
  if (app) {
    for (;;) {
      const path = await ask('  Extra path on the app, e.g. /api (empty to finish)');
      if (!path) break;
      paths.push([path, await ask(`  Port or URL for ${path}`)]);
    }
  }
  const services = [];
  for (;;) {
    const name = await ask('Sub-service name, e.g. mail (empty to finish)');
    if (!name) break;
    services.push([name, await ask(`  Port or URL for ${slug(name)}`)]);
  }
  return buildDoc({ project, app, paths, services });
}

export async function add(projectArg, opts = {}, ask) {
  const file = resolve(opts.file || 'tunnel.yml');
  if (existsSync(file) && !opts.force) throw new Error(`${file} already exists. Use --force to overwrite it.`);
  const services = (opts.service || []).map((s) => parsePair(s, '--service'));
  const paths = (opts.path || []).map((s) => parsePair(s, '--path'));
  const project = slug(projectArg || basename(dirname(file)));
  const hasFlags = !!opts.app || services.length > 0;

  let doc;
  if (hasFlags || opts.yes) {
    if (!hasFlags) throw new Error('Pass --app and/or --service (or run without --yes to be prompted).');
    doc = buildDoc({ project, app: opts.app, paths, services });
  } else if (ask || process.stdin.isTTY) {
    let rl;
    if (!ask) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      ask = readlineAsk(rl);
    }
    try { doc = await promptDoc(ask, { project, app: '' }); } finally { rl?.close(); }
  } else {
    throw new Error('Not a terminal: pass --app and/or --service to create tunnel.yml without prompts.');
  }

  const text = renderYaml(doc);
  writeFileSync(file, text);
  console.log(`Wrote ${file}`);
  const cfg = loadConfig();
  if (cfg.domain) {
    for (const h of hostnames(parseProject(text), cfg.domain)) console.log(`  ${h.service.padEnd(10)} https://${h.hostname}`);
  }
  console.log(`Next: burrow up${opts.file ? ` -f ${opts.file}` : ''}`);
  return { file, doc };
}
