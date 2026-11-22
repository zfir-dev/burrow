#!/usr/bin/env node
// node-guard:start
if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error(`burrow needs Node.js 18 or newer (found ${process.versions.node}).`);
  process.exit(1);
}
// node-guard:end
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import * as cmd from '../src/commands.js';
import * as dash from '../src/dashboard/manage.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const program = new Command();
program.name('burrow').description('Manage Cloudflare Tunnels for local projects').version(pkg.version);
program.command('completion <shell>')
  .description('print a shell completion script: bash | zsh')
  .action(async (shell) => {
    try { (await import('../src/completion.js')).completion(shell, program); } catch (e) {
      console.error(`burrow: ${e.message}`);
      process.exitCode = 1;
    }
  });
program.command('__complete <what>', { hidden: true })
  .action(async (what) => (await import('../src/completion.js')).complete(what));

const wrap = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) {
    console.error(`burrow: ${e.message}`);
    process.exitCode = 1;
  }
};
program.command('update')
  .description('update burrow from GitHub (git checkout: git pull --ff-only + npm install; global install: npm i -g)')
  .option('--check', 'only report whether a newer commit or version exists')
  .option('--dry-run', 'print what would run')
  .option('--force', 'global install: reinstall even when up to date')
  .action(wrap(async (o) => (await import('../src/update.js')).update(o)));
program.command('url [project]')
  .description("print a project's public URLs")
  .option('-f, --file <path>', 'path to tunnel.yml')
  .option('--plain', 'URLs only, one per line')
  .action(wrap(async (p, o) => (await import('../src/open.js')).url(p, o)));
program.command('open [project] [service]')
  .description('open a project URL in the browser (the app, or the given service)')
  .option('-f, --file <path>', 'path to tunnel.yml')
  .option('--print', 'print the URL instead of opening it')
  .action(wrap(async (p, s, o) => (await import('../src/open.js')).open(p, s, o)));

program.command('export [file]')
  .description('export remembered project configs (no secrets) to a file or stdout')
  .option('--project <list>', 'comma-separated projects (default: all)')
  .option('--json', 'JSON instead of YAML')
  .action(wrap(async (f, o) => (await import('../src/transfer.js')).exportProjects(f, o)));
program.command('import <file>')
  .description('import project configs from a burrow export')
  .option('--dir <dir>', 'where to write the tunnel.yml files (default ~/.config/burrow/projects)')
  .option('--force', 'replace existing files and remembered paths')
  .option('--dry-run', 'print what would be written')
  .action(wrap(async (f, o) => (await import('../src/transfer.js')).importProjects(f, o)));
program.command('init').description('write the config template, or verify the API token').action(wrap(() => cmd.init({})));
program.command('add [project]')
  .description('create a tunnel.yml (prompts, or use flags)')
  .option('-f, --file <path>', 'where to write', 'tunnel.yml')
  .option('--app <target>', 'root service: port or URL')
  .option('--path <prefix=target>', 'extra path on the app (repeatable)', (v, a) => a.concat(v), [])
  .option('--service <name=target>', 'sub-service (repeatable)', (v, a) => a.concat(v), [])
  .option('--force', 'overwrite an existing file')
  .option('-y, --yes', 'never prompt')
  .action(wrap(async (p, o) => (await import('../src/add.js')).add(p, o)));
program.command('edit [project]')
  .description('open tunnel.yml in $EDITOR, validate it on save, and offer to apply it if the project is running')
  .option('-f, --file <path>', 'path to tunnel.yml')
  .option('--no-apply', 'only save, never re-run up')
  .option('-y, --yes', 'apply without asking when the project is running')
  .option('--dry-run', 'apply as "up --dry-run"')
  .action(wrap(async (p, o) => (await import('../src/edit.js')).edit(p, o)));
program.command('up [project]')
  .description('create/reuse tunnel, set ingress and DNS, start cloudflared')
  .option('-f, --file <path>', 'path to tunnel.yml')
  .option('--dry-run', 'print the plan without calling Cloudflare or starting anything')
  .option('--force', 'replace DNS records not managed by burrow on the same hostnames')
  .action(wrap((p, o) => cmd.up(p, o)));
program.command('share <target>')
  .description('share a local port or URL on a temporary <random>.<domain> hostname')
  .option('--name <label>', 'pick the hostname label instead of a random one')
  .option('--detach', 'keep running in the background (remove with burrow down)')
  .option('--dry-run', 'print the plan only')
  .action(wrap(async (t, o) => (await import('../src/share.js')).share(t, o)));
program.command('down [project]')
  .description('stop cloudflared (all running projects when none is given); keeps tunnel and DNS')
  .option('-f, --file <path>', 'path to tunnel.yml')
  .option('--purge', 'same as "burrow destroy"')
  .option('--all', 'with --purge and no project: every burrow tunnel')
  .option('-y, --yes', 'with --purge --all: skip the confirmation')
  .option('--dry-run', 'print what would happen')
  .action(wrap((p, o) => cmd.down(p, o)));
program.command('restart [project]')
  .description('re-sync and restart a project (all running projects when none is given)')
  .option('-f, --file <path>', 'path to tunnel.yml')
  .option('--dry-run', 'print the plan only')
  .action(wrap(async (p, o) => (await import('../src/restart.js')).restart(p, o)));
program.command('destroy [project]')
  .description('stop cloudflared and delete the tunnel and its DNS records')
  .option('-f, --file <path>', 'path to tunnel.yml')
  .option('--all', 'every burrow-* tunnel and burrow:* DNS record (asks first)')
  .option('-y, --yes', 'skip the confirmation for --all')
  .option('--dry-run', 'print what would be deleted')
  .action(wrap((p, o) => cmd.destroy(p, o)));
program.command('prune')
  .description('delete orphaned burrow-* tunnels and burrow:* DNS records (asks first)')
  .option('--dry-run', 'list orphans only')
  .option('-y, --yes', 'skip the confirmation')
  .option('--include-active', 'also prune tunnels that still have live connections')
  .action(wrap(async (o) => (await import('../src/prune.js')).prune(o)));
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
program.command('ls').description('list burrow tunnels, hostnames and running state')
  .option('--json', 'machine-readable output')
  .action(wrap((o) => cmd.ls(o)));
program.command('status [project]').description('show one project')
  .option('-f, --file <path>', 'path to tunnel.yml')
  .option('--json', 'machine-readable output')
  .action(wrap((p, o) => cmd.status(p, o)));
program.command('service <action>')
  .description('systemd user unit that brings projects up at boot: install | uninstall | status')
  .option('--projects <list>', 'install: comma-separated projects (default: autostart projects, re-read at boot)')
  .option('--now', 'install: also start it now')
  .option('--dry-run', 'print what would happen')
  .action(wrap(async (a, o) => (await import('../src/service.js')).service(a, o)));
program.command('autostart [projects...]')
  .description('bring up autostart projects (what the systemd unit runs)')
  .option('--dry-run', 'print the list only')
  .action(wrap(async (p, o) => (await import('../src/service.js')).autostart(p, o)));
program.command('watch [projects...]')
  .description('watch connectors, tunnels and local ports; alert on changes (webhook, ntfy)')
  .option('--interval <seconds>', 'seconds between checks', '60')
  .option('--debounce <n>', 'checks in a row before a change alerts', '2')
  .option('--once', 'check once and exit (for cron)')
  .option('--dry-run', 'print alerts instead of sending them')
  .option('--install-service', 'install a systemd user unit that runs burrow watch')
  .option('--uninstall-service', 'remove that unit')
  .action(wrap(async (p, o) => (await import('../src/watch.js')).watch(p, o)));
program.command('logs [project]').description('show cloudflared logs')
  .option('-f, --file <path>', 'path to tunnel.yml')
  .option('-n, --lines <n>', 'number of lines', '100')
  .option('--follow', 'follow the log')
  .action(wrap((p, o) => cmd.logs(p, o)));
program.command('doctor [project]')
  .description('check config, token, zone, cloudflared and local service ports')
  .option('-f, --file <path>', 'path to tunnel.yml')
  .option('--offline', 'skip the Cloudflare API checks')
  .action(wrap(async (p, o) => (await import('../src/doctor.js')).doctor(p, o)));
program.command('stats [project]')
  .description('requests, bandwidth and status codes per hostname (Cloudflare GraphQL Analytics)')
  .option('-f, --file <path>', 'path to tunnel.yml')
  .option('--since <window>', 'time window: 30m, 24h, 7d or an ISO date', '24h')
  .option('--json', 'machine-readable output')
  .action(wrap(async (p, o) => (await import('../src/stats.js')).stats(p, o)));

await program.parseAsync();
