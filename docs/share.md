# burrow share

Shares a local port on a temporary hostname, no `tunnel.yml` needed:

```console
$ burrow share 5173
Sharing http://localhost:5173 at https://k3x9q2mf7a.example.dev (cloudflared pid 41234, log …)
Press Ctrl+C to stop sharing and remove the hostname.
^C
Removing share…
Removed https://k3x9q2mf7a.example.dev
```

- The hostname is `<random>.<domain>`: 10 random lowercase characters, one level deep, so
  the free Universal SSL certificate covers it. Use `--name <label>` to pick the label.
- The target can be a port (`http://localhost:<port>`) or an `http(s)://` URL.
- Behind the scenes a share is a project called `share-<label>`: tunnel
  `burrow-share-<label>`, DNS comment `burrow:share-<label>`, and state files
  `share-<label>.{pid,log,json}` in `~/.local/state/burrow/`.
- **Ctrl+C** (or SIGTERM) stops cloudflared and deletes the tunnel, the DNS record and the state.
- `--detach` leaves it running in the background. `burrow down share-<label>`, or a bare
  `burrow down`, removes it completely (unlike normal projects, whose tunnel and DNS are kept).
  `burrow destroy share-<label>` works too.
- `--expires <duration>` (`30m`, `2h`, `7d`; 1 minute to 30 days) gives it an end time,
  stored in `share-<label>.json` as `expiresAt`. A foreground share removes itself when that
  time passes. A detached share gets a small background watcher process
  (`burrow _share-expire share-<label>`, its pid is `expiryPid` in the state file) that
  removes it at that time like `burrow down share-<label>`, so no dashboard is needed. See
  [Expiry](#expiry).
- `--dry-run` prints the plan without calling Cloudflare.
- `--domain <domain>` shares on another zone of the account (`<label>.example.org`) instead of
  `BURROW_DOMAIN`; the zone is checked like a project's [`domain:`](domains.md).
- `-f <tunnel.yml>` (or `--project <name>`, which uses the tunnel.yml its last `burrow up`
  remembered) shares *for* that project: its `domain:` is used unless `--domain` is given, and
  its [hooks](hooks.md) run around the share: `pre_up` before the tunnel is created, `post_up`
  once cloudflared runs, `pre_down`/`post_down` on Ctrl+C or `burrow down share-<label>`.
  Hooks get `BURROW_PROJECT=share-<label>`, the share's `BURROW_URL` and `BURROW_HOSTNAMES`,
  `BURROW_SHARE=1` and `BURROW_SHARE_OF=<project>`, and run in the tunnel.yml directory. A
  background `pre_up` belongs to the share (its own pid file), not to the project.
  `--no-hooks` skips them, also at `down`.
- The zone and project file are kept in `share-<label>.json` (`domain`, `zoneId`,
  `projectFile`), so `restart`, `down` and `destroy` use the same zone later.
- Don't name your own projects `share-…`, so they can't be mistaken for shares.

### Expiry

| Share | Who enforces `expiresAt` |
| ----- | ------------------------ |
| foreground `burrow share --expires …` | the `burrow share` process itself (checks every 2 s) |
| `--detach --expires …`, or started from the dashboard with an expiry | its expiry watcher (sleeps until the expiry, re-reading the state file at least every 15 s) |
| any of them, as a fallback | the dashboard, when it runs (within about 30 s, or when it next starts) |

The watcher re-reads `expiresAt`, so **+1 hour** in the dashboard (or editing the state
file) moves the end time; setting it to never ends the watcher. It removes the share like
`burrow down`, records **share expired** in the history and exits; it also exits when the
share is removed some other way. It doesn't survive a reboot, but neither does the share's
cloudflared: `burrow restart` (or autostart) brings the share back and starts the watcher
again, which removes the share at once if it expired meanwhile.

### From the dashboard

The dashboard and a terminal `burrow share` use the same state file, so a share started in a
terminal shows up in the **Shares** panel too. **+1 hour** sets a new `expiresAt`, which the
terminal process picks up within 2 seconds. **Stop** sets `stopRequestedAt`; the terminal
process sees it, removes the tunnel and DNS record and exits as if you'd pressed Ctrl+C. If
that process is gone (or doesn't finish within 10 seconds), the dashboard runs
`burrow down share-<label>` itself.

## Restart, completion and export

- `burrow restart` (no project) restarts detached shares along with projects: it re-applies
  the share's ingress, recreates its CNAME if it's missing, and starts cloudflared again on
  the same tunnel and hostname. `burrow restart share-<label>` does that for one share.
  - A share whose `burrow share` is still running in the foreground is **skipped**, because
    that process owns it (and removes it on Ctrl+C). Once that process is gone, restart
    adopts the share as a detached one.
  - If the share's tunnel was deleted on Cloudflare, restart removes the local share state
    and prints the `burrow share … --name <label>` command to create it again.
- Shell completion offers share names for `down`, `destroy`, `restart`, `status` and `logs`,
  and leaves them out for commands that need a `tunnel.yml` (`up`, `url`, `open`, …).
  `burrow __complete targets` lists projects and shares, `burrow __complete shares` only shares.
- `burrow export` never includes shares. When there are some, it prints a note on stderr
  (and as a comment at the top of a YAML export). `burrow export --project share-<label>`
  fails with an explanation.

