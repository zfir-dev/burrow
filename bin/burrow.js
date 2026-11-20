#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import * as cmd from '../src/commands.js';

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
  .description('stop cloudflared, delete DNS records and the tunnel')
  .option('-f, --file <path>', 'path to tunnel.yml')
  .option('--dry-run', 'print what would be removed')
  .action(wrap((p, o) => cmd.down(p, o)));
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
