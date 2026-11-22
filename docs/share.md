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
- `--dry-run` prints the plan without calling Cloudflare.
- Don't name your own projects `share-…`, so they can't be mistaken for shares.

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

