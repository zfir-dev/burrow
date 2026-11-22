# Hooks

`hooks:` in `tunnel.yml` runs shell commands around `burrow up` and `burrow down`:

```yaml
project: acme-shop
services:
  - name: app
    url: http://localhost:3100
hooks:
  pre_up:                      # start the dev server first, keep it running
    run: npx next dev -p 3100
    background: true
    wait_for: 3100             # wait until localhost:3100 accepts connections
    timeout: 60
  post_up: echo "live at $BURROW_URL"
  pre_down: npm run db:dump
  post_down: docker compose stop
```

| Hook | When | If it fails |
| ---- | ---- | ----------- |
| `pre_up` | before burrow touches Cloudflare | `up` stops; nothing is created or changed |
| `post_up` | after cloudflared started | reported, exit code 1, the tunnel stays up |
| `pre_down` | before cloudflared is stopped | reported, `down` carries on |
| `post_down` | after cloudflared (and the background process) stopped | reported |

- A hook is a command string, or `{ run, timeout, background, wait_for }`.
- Commands run with `/bin/sh -c` in the directory that holds `tunnel.yml`, with the usual
  environment plus `BURROW_PROJECT`, `BURROW_HOSTNAMES` (comma-separated), `BURROW_URL`
  (the root service URL), `BURROW_HOOK`, and `BURROW_TUNNEL_ID` for `post_up`. Output goes
  to the terminal.
- `timeout` (seconds, default 120, max 3600): a hook that runs longer is stopped
  (SIGTERM to its process group, SIGKILL 3 s later) and counts as failed.
- `background: true` (only `pre_up`) starts the command detached in its own process group;
  its pid is kept in `~/.local/state/burrow/hooks/<project>.pid` and its output goes to
  `hooks/<project>.log`. With `wait_for: <port>` (or `host:port`), `up` waits until the port
  accepts connections; if the process exits or the port doesn't open within `timeout`,
  burrow stops it and `up` fails. A later `up` (or `restart`) keeps an already running
  background process. `down` and `destroy` stop it.
- `down` runs `pre_down`/`post_down` only for projects with something running. It uses the
  `tunnel.yml` remembered by the last `up`, so `burrow down` from any directory works.
- `--no-hooks` on `up` or `down` skips the hooks. `down --no-hooks` still stops a background
  `pre_up` process. `--dry-run` lists the hooks that would run. `destroy` runs no hooks.
- Hooks are never copied by `burrow export`, so an imported bundle can't carry commands.
