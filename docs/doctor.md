# burrow doctor

Checks that everything burrow needs is in place and prints one line per check:
`✓` passed, `!` warning, `✗` failed, `-` skipped. It exits with status 1 when anything fails.

```console
$ burrow doctor

Config
  ✓ config file - /home/me/.config/burrow/config.env
  ✓ config permissions - 600
  ✓ CF_API_TOKEN - set
  ✓ CF_ACCOUNT_ID - set
  ✓ BURROW_DOMAIN - example.dev

Cloudflare API
  ✓ token - active
  ✓ zone - example.dev (0123…)
  ✓ tunnel access - 3 tunnel(s) in the account
  ✓ DNS access - 5 burrow record(s)

cloudflared
  ✓ cloudflared - cloudflared version 2026.11.1 (built …)

Project acme-shop (/home/me/code/acme-shop/tunnel.yml)
  ✓ app ^/auth/v1(/.*)?$ -> http://localhost:54321 - reachable
  ✓ app -> http://localhost:3100 - reachable
  ✗ mail -> http://localhost:54324 - connection refused

12 passed, 0 warning(s), 1 failed
```

- **Config:** the config file exists, is mode 600, and has the token, account ID and a valid domain.
  The token value is never printed.
- **Cloudflare API:** verifies the token, resolves the zone, and lists tunnels and burrow DNS records.
  These checks are read-only. `--offline` skips them.
- **cloudflared:** runs `cloudflared --version` (or `CLOUDFLARED_BIN`).
- **Projects:** opens a TCP connection to every service and path target. It checks
  `burrow doctor <project>`, `-f <file>`, or `./tunnel.yml`; with none of those, every project
  burrow remembers. For each project it also:
  - checks the zone of its own [`domain:`](domains.md), when that differs from `BURROW_DOMAIN`
    (fails if the zone isn't on the account or the token can't see it; skipped with `--offline`);
  - validates its [`hooks:`](hooks.md) (fails on the same errors `burrow up` would), and warns
    when a hook's command can't be found. See [Hook commands](#hook-commands).

```console
Project acme-shop (/home/me/code/acme-shop/tunnel.yml)
  ✓ domain example.org - zone 4d2e…
  ✓ hook pre_up (background) - found: cd, npm
  ! hook post_up - npm: no "notify" script in /home/me/code/acme-shop/web/package.json
  ! hook pre_down - notify-send not found on PATH
  ✓ app -> http://localhost:3100 - reachable
```

### Hook commands

Hooks are `/bin/sh` command lines. Doctor reads them with a small shell-word parser and
**never runs anything**:

- The line is split into simple commands at `;`, `&`, `&&`, `||`, `|` and newlines, honouring
  `'…'`, `"…"`, backslashes and comments; redirections (`> log`, `2>&1`, `< in`) are skipped.
- In each command, `NAME=value` prefixes and wrappers (`env`, `exec`, `nohup`, `command`,
  `time`, `nice`, `setsid`) are skipped, and the command is checked: shell builtins (`cd`,
  `export`, `echo`, `test`, …) are fine, `./script` or `/abs/path` must be an executable
  file, anything else must be on `PATH`.
- `cd <dir>` is followed: the directory must exist, and later commands are checked there
  (`cd web && ./start.sh` looks for `web/start.sh`).
- `npm run <x>`, `npm start|test|stop|restart`, `yarn [run] <x>` and `pnpm [run] <x>` also need
  script `<x>` in that directory's `package.json`. `npm start` with no `start` script but a
  `server.js` is npm's default (`node server.js`): it passes, with a *note* saying so.
- Compound commands are read, not skipped: the commands inside `$(…)`, backticks (also in
  `"…"`), `( … )` subshells, `{ …; }` groups, `if`/`elif`/`else`, `while`/`until`/`for` loops
  (conditions and bodies) and `case` arms are checked like any other. A `cd` inside a subshell
  or `$(…)` stays there; each `then`/`else` body and `case` arm starts in the directory the block
  began in; and after a block that `cd`s, later relative paths are *not checked* (it depends on
  which branch ran). Here-document bodies are skipped.
- What can't be known without running it is listed as *not checked* instead of being
  guessed: a command or `cd` target that is a `$VARIABLE` or `$(…)` output, function
  definitions, and anything unterminated.

A problem is a warning (`!`), not a failure: PATH can differ when the hook really runs.

`--json` prints the report as one line of JSON (`counts` and `checks`, each with `section`,
`status`, `label`, `detail` and, for warnings and failures, a `fix` hint). `--all` checks every
remembered project and ignores `./tunnel.yml`. The dashboard's **Doctor** panel uses both.
