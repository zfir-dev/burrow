# Per-project domains

By default every project uses `BURROW_DOMAIN`. Set `domain:` in a `tunnel.yml` to put that
project on another domain (another Cloudflare zone on the same account):

```yaml
project: todo-api
domain: example.org        # todo-api.example.org, docs-todo-api.example.org
services:
  - name: app
    url: http://localhost:4000
  - name: docs
    url: http://localhost:4001
```

- The naming rule stays the same (`<project>.<domain>`, `<service>-<project>.<domain>`), so
  the zone's free Universal SSL certificate still covers every hostname.
- **Zone check and cache**: the first `up` for a domain looks its zone up
  (`GET /zones?name=<domain>&account.id=<CF_ACCOUNT_ID>`) and refuses to continue unless the
  zone belongs to `CF_ACCOUNT_ID`; nothing is created before that check. The zone ID is cached
  in `~/.local/state/burrow/cache/zones.json` for 7 days (delete the file to look again).
  `CF_ZONE_ID` only ever applies to `BURROW_DOMAIN`.
- `burrow up` records the project's domain and zone in its state file. If you change
  `domain:`, the next `up` deletes the project's records in the old zone and creates them in
  the new one, on the same tunnel.
- `destroy`, `prune`, `ls`, `status` and the dashboard look at every zone burrow knows about
  (`BURROW_DOMAIN`'s, the cached ones, and those remembered for projects), so records on other
  domains are found and deleted in the right zone. `url`/`open` print the project's own domain.
  `down` never calls Cloudflare.
- With `domain:` set, `BURROW_DOMAIN` isn't required for that project (`up --dry-run` works
  with no config at all).
- The token needs the same permissions on every zone you use: **Zone > DNS > Edit**, plus
  **Zone > Zone > Read** to look the zone up.
- `burrow export` keeps `domain:`.
- The dashboard's project form has a **Domain** picker (Cloudflare zones on the account, cached
  zones and domains in use, or any other name), and its hostname and rename previews use the
  project's domain.

## When a zone can't be read

If the token loses access to one of the zones burrow knows (or Cloudflare returns an error for
it), the rest keeps working:

- `burrow ls` still lists every tunnel. Projects whose DNS is in that zone (the zone `burrow up`
  remembered for them, else `BURROW_DOMAIN`'s) show `hostnames unknown: zone <domain>
  unreadable`, a warning per zone goes to stderr, and the exit code is **1** because the
  output is incomplete. It's 0 when the unreadable zone holds none of the listed projects.
- `burrow ls --json` adds `hostnamesKnown` (false for those projects) and `zoneError`
  (`{ zone, error }`, else `null`) to each entry.
- `burrow status <project>` prints `DNS: unknown, zone <domain> unreadable (…)` and exits 1
  only when that project's zone is the unreadable one; `--json` adds `recordsKnown`,
  `zoneError` and `zoneErrors` (every zone that failed, `[{ zone, error }]`).
- The dashboard table keeps tunnel and local state for every project; affected projects show
  their remembered hostnames with **unknown: zone … unreadable** (the error on hover), and the
  top bar says **DNS unreadable in …**. `GET /api/tunnels` has `zoneError` per project and
  `cloudflare.zoneErrors`.

`burrow destroy` queues DNS deletions in such a zone and `burrow prune` retries them (see
[prune](prune.md#queued-dns-deletions)).

