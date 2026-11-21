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
