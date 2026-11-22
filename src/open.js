import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig, requireConfig } from './config.js';
import { assertLabel } from './naming.js';
import { findProjectFile, loadProjectFile, hostnames, DASHBOARD_PROJECT, dashboardProject } from './project.js';
import { readMeta } from './process.js';
import { projectDomain } from './zones.js';

// [{ service, url }] for a project: from its tunnel.yml (-f, ./tunnel.yml or the
// remembered file), falling back to the hostnames saved by the last `burrow up`.
export function projectUrls(projectArg, opts = {}, cfg = loadConfig()) {
  if (projectArg) assertLabel(projectArg, 'project name');
  let proj = null;
  if (projectArg === DASHBOARD_PROJECT && !opts.file) proj = dashboardProject(cfg.dashboardPort);
  const local = !proj && findProjectFile(opts.file);
  if (local) {
    const p = loadProjectFile(local);
    if (!projectArg || p.project === projectArg) proj = p;
  }
  const meta = projectArg ? readMeta(projectArg) : null;
  if (!proj && meta?.file && existsSync(meta.file)) proj = loadProjectFile(meta.file);
  if (proj) {
    if (!proj.domain) requireConfig(cfg, ['domain']);
    return { project: proj.project, urls: hostnames(proj, projectDomain(proj, cfg)).map((h) => ({ service: h.service, url: `https://${h.hostname}` })) };
  }
  if (meta?.hostnames?.length) {
    return { project: projectArg, urls: meta.hostnames.map((h) => ({ service: h.split('.')[0], url: `https://${h}` })) };
  }
  throw new Error(projectArg ? `Unknown project "${projectArg}". Run burrow up -f <file> once, or pass -f.` : 'Pass a project name or run inside a directory with tunnel.yml.');
}

export function openerCommand(url, platform = process.platform, env = process.env) {
  if (env.BROWSER) return [env.BROWSER, [url]];
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  return ['xdg-open', [url]];
}

export async function url(projectArg, opts = {}) {
  const { urls } = projectUrls(projectArg, opts);
  const width = Math.max(...urls.map((u) => u.service.length));
  for (const u of urls) console.log(opts.plain ? u.url : `${u.service.padEnd(width)}  ${u.url}`);
}

export async function open(projectArg, serviceArg, opts = {}) {
  // `burrow open mail` inside a project directory: treat the only argument as a service.
  if (projectArg && !serviceArg) {
    const local = findProjectFile(opts.file);
    if (local) {
      const p = loadProjectFile(local);
      if (p.project !== projectArg && p.services.some((s) => s.name === projectArg)) {
        serviceArg = projectArg;
        projectArg = undefined;
      }
    }
  }
  const { project, urls } = projectUrls(projectArg, opts);
  const target = serviceArg ? urls.find((u) => u.service === serviceArg) : urls.find((u) => u.service === 'app') || urls[0];
  if (!target) throw new Error(`${project} has no service "${serviceArg}" (has: ${urls.map((u) => u.service).join(', ')})`);
  if (opts.print) { console.log(target.url); return; }
  const [bin, args] = openerCommand(target.url);
  await new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'ignore', detached: true });
    child.once('error', () => { console.log(`Couldn't start a browser (${bin}). Open ${target.url}`); resolve(); });
    child.once('spawn', () => { child.unref(); console.log(`Opening ${target.url}`); resolve(); });
  });
}
