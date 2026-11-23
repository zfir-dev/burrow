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
    when a hook's command can't be found: the first word on `PATH`, or a `./script` relative to
    the tunnel.yml directory. Commands starting with variable assignments, shell builtins or
    other shell syntax aren't second-guessed.

```console
Project acme-shop (/home/me/code/acme-shop/tunnel.yml)
  ✓ domain example.org - zone 4d2e…
  ✓ hook pre_up (background) - /usr/bin/npm
  ! hook post_up - notify-send not found on PATH
  ✓ app -> http://localhost:3100 - reachable
```

`--json` prints the report as one line of JSON (`counts` and `checks`, each with `section`,
`status`, `label`, `detail` and, for warnings and failures, a `fix` hint). `--all` checks every
remembered project and ignores `./tunnel.yml`. The dashboard's **Doctor** panel uses both.
