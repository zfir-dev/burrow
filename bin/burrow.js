#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import * as cmd from '../src/commands.js';
import * as dash from '../src/dashboard/manage.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const program = new Command();
program.name('burrow').description('Manage Cloudflare Tunnels for local projects').version(pkg.version);

const wrap = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) {
    console.error(`burrow: ${e.message}`);
    process.exitCode = 1;
  }
};

program.command('init').description('write the config template, or verify the API token').action(wrap(() => cmd.init({})));
program.command('up [project]')
  .description('create/reuse tunnel, set ingress and DNS, start cloudflared')
  .option('-f, --file <path>', 'path to tunnel.yml')
  .option('--dry-run', 'print the plan without calling Cloudflare or starting anything')
  .option('--force', 'replace DNS records not managed by burrow on the same hostnames')
  .action(wrap((p, o) => cmd.up(p, o)));
program.command('down [project]')
  .description('stop cloudflared (all running projects when none is given); keeps tunnel and DNS')
  .option('-f, --file <path>', 'path to tunnel.yml')
  .option('--purge', 'same as "burrow destroy"')
  .option('--all', 'with --purge and no project: every burrow tunnel')
  .option('-y, --yes', 'with --purge --all: skip the confirmation')
  .option('--dry-run', 'print what would happen')
  .action(wrap((p, o) => cmd.down(p, o)));
program.command('destroy [project]')
  .description('stop cloudflared and delete the tunnel and its DNS records')
  .option('-f, --file <path>', 'path to tunnel.yml')
  .option('--all', 'every burrow-* tunnel and burrow:* DNS record (asks first)')
  .option('-y, --yes', 'skip the confirmation for --all')
  .option('--dry-run', 'print what would be deleted')
  .action(wrap((p, o) => cmd.destroy(p, o)));
program.command('dashboard [action]')
  .description('web dashboard: no action = run in foreground; up | down | status to manage it in the background')
  .option('--port <port>', 'port (default BURROW_DASHBOARD_PORT or 7070)')
  .option('--host <host>', 'bind address', '127.0.0.1')
  .option('--no-tunnel', 'with "up": do not expose it on burrow.<domain>')
  .option('--dry-run', 'with "up": print the plan only')
  .action(wrap(async (action, o) => {
    if (!action) return dash.foreground(o);
    if (action === 'up') return dash.up(o);
    if (action === 'down') return dash.down(o);
    if (action === 'status') return dash.status(o);
    throw new Error(`Unknown dashboard action "${action}" (use up, down or status)`);
  }));
program.command('ls').description('list burrow tunnels, hostnames and running state').action(wrap(() => cmd.ls()));
program.command('status [project]').description('show one project')
  .option('-f, --file <path>', 'path to tunnel.yml')
  .action(wrap((p, o) => cmd.status(p, o)));
program.command('logs [project]').description('show cloudflared logs')
  .option('-f, --file <path>', 'path to tunnel.yml')
  .option('-n, --lines <n>', 'number of lines', '100')
  .option('--follow', 'follow the log')
  .action(wrap((p, o) => cmd.logs(p, o)));

await program.parseAsync();
