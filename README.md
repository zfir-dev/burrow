# burrow

`burrow` is a small CLI that exposes local projects through **Cloudflare Tunnel**.
It creates a remotely-managed tunnel, its ingress rules and the DNS records through
the Cloudflare API, and runs `cloudflared` in the background. `burrow down` stops it; `burrow destroy` removes
all of it, so no stale tunnels or CNAMEs are left behind.

## Naming rule

Only flat, one-level hostnames are used, so Cloudflare's free Universal SSL
certificate (`*.<domain>`) covers every hostname:

| Service            | Hostname                       |
| ------------------ | ------------------------------ |
| root (`app`)       | `<project>.<domain>`           |
| any other service  | `<service>-<project>.<domain>` |

Example with `BURROW_DOMAIN=example.dev`: `inktion.example.dev`,
`mail-inktion.example.dev`, `studio-inktion.example.dev`.

Cloudflare objects are named and tagged so burrow can find them again:

- tunnel: `burrow-<project>`
- DNS records: proxied `CNAME <host> -> <tunnel-id>.cfargotunnel.com` with comment `burrow:<project>`

## Install

Requires Node 18+ and [`cloudflared`](https://github.com/cloudflare/cloudflared/releases).

```sh
git clone git@github.com:zfir-dev/burrow.git && cd burrow
npm install
npm link        # puts `burrow` on PATH
```

## Setup

1. Add the tunnel domain to Cloudflare (it has to be an active zone).
2. Create an API token at **My Profile > API Tokens > Create Token > Custom token**:
   - **Account > Cloudflare Tunnel > Edit**
   - **Zone > DNS > Edit**, limited to the tunnel domain's zone
   - optional **Zone > Zone > Read**, only if you leave `CF_ZONE_ID` empty (used to look up the zone ID)
3. Run `burrow init`. It writes `~/.config/burrow/config.env` (mode 600):

   ```env
   CF_API_TOKEN=...
   CF_ACCOUNT_ID=...
   CF_ZONE_ID=          # optional
   BURROW_DOMAIN=example.dev
   CLOUDFLARED_BIN=cloudflared
   ```

4. Fill it in and run `burrow init` again. It verifies the token
   (`/user/tokens/verify`) and checks tunnel and DNS access. The token is never printed.

Every value can also come from the environment. `BURROW_CONFIG` and
`BURROW_STATE_DIR` override the config file and state directory paths.

## tunnel.yml

Put a `tunnel.yml` in the project directory, or pass one with `-f`.

```yaml
project: inktion
services:
  - name: app                 # "app" is the root service (or set root: true on one service)
    url: http://localhost:3100
    paths:                    # path rules on the same hostname, checked first
      - { path: /auth/v1, url: http://localhost:54321 }
      - { path: /rest/v1, url: http://localhost:54321 }
      - { path: /storage/v1, url: http://localhost:54321 }
      - { path: /realtime/v1, url: http://localhost:54321 }
  - name: mail
    url: http://localhost:54324
  - name: studio
    url: http://localhost:54323
```

- `project` and `name` must be lowercase DNS labels with no dots.
- `paths[].path` is a prefix. `/auth/v1` matches `/auth/v1` and everything below it.
  A value that starts with `^` is used as a raw regex.
- `originRequest` (on a service or a path) is passed through to cloudflared, e.g.
  `originRequest: { noTLSVerify: true }`.
- burrow adds a final `http_status:404` rule.

See [`examples/inktion.tunnel.yml`](examples/inktion.tunnel.yml).

## Commands

| Command                          | What it does |
| -------------------------------- | ------------ |
| `burrow init`                    | Write the config template, or verify the token and access |
| `burrow up [project]`            | Create or reuse tunnel `burrow-<project>`, PUT its ingress config, upsert the CNAMEs (and remove stale ones tagged for this project), then (re)start `cloudflared` in the background |
| `burrow down [project]`          | Stop that project's `cloudflared` only. The tunnel and DNS records are kept, so the next `up` is quick |
| `burrow down`                    | Stop **every** running burrow connector (each pid in `~/.local/state/burrow/`) |
| `burrow destroy [project]`       | Stop `cloudflared`, delete DNS records tagged `burrow:<project>`, delete the tunnel's connections and the tunnel. `burrow down <project> --purge` does the same |
| `burrow destroy --all`           | Delete every `burrow-*` tunnel and every `burrow:*` DNS record, and stop all local connectors. Asks `[y/N]` first; `--yes` skips the prompt (needed in non-interactive shells) |
| `burrow ls`                      | List `burrow-*` tunnels with their hostnames and local running state |
| `burrow status [project]`        | Local process, tunnel health, DNS records |
| `burrow logs [project]`          | Show the cloudflared log (`-n 200`, `--follow`) |

`destroy` with no project and no `--all` refuses to run.

Options:

- `-f, --file <path>` uses a specific tunnel.yml (and picks its project).
- `--dry-run` (`up`, `down`, `destroy`) prints the plan. `up` and `down` stay fully offline.
  `destroy --all --dry-run` lists what is on Cloudflare when a token is configured.
- `--force` (`up`) replaces existing DNS records on the same hostnames that burrow doesn't manage.
  Without it, burrow refuses to touch them.

`up` is idempotent, so run it again after editing tunnel.yml. Once a project has been
brought up, `burrow up <project>` works from any directory because burrow remembers
where its tunnel.yml lives.

State lives in `~/.local/state/burrow/`: `<project>.pid`, `<project>.log` and
`<project>.json` (tunnel id, file path). The tunnel token goes to cloudflared through
the `TUNNEL_TOKEN` environment variable. It is never written to disk or shown in `ps`.

## Tests

```sh
npm test
```
