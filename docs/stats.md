# burrow stats

```sh
burrow stats [project] [-f <tunnel.yml>] [--since 24h] [--json]
```

Shows traffic per hostname of a project from Cloudflare's
[GraphQL Analytics API](https://developers.cloudflare.com/analytics/graphql-api/):
requests, bandwidth (edge response bytes) and a status-code breakdown (2xx/3xx/4xx/5xx,
plus the most common codes).

```text
acme-shop: 2026-11-20T11:00:00Z -> 2026-11-21T11:00:00Z (Cloudflare analytics, sampled)
HOSTNAME                        REQUESTS   BANDWIDTH       2xx       3xx       4xx       5xx
acme-shop.example.dev              1,290     12.0 MB     1,200        50        40         0
mail-acme-shop.example.dev             0         0 B         0         0         0         0
studio-acme-shop.example.dev           2       200 B         0         0         0         2
total                              1,292     12.0 MB     1,200        50        40         2
Status codes: 200 1,200, 304 50, 404 40, 500 2
```

- The project's hostnames come from its `tunnel.yml` (`-f`, `./tunnel.yml` or the remembered
  file), or the hostnames saved by the last `burrow up`.
- `--since` takes `30m`, `24h` (default), `7d`, `2w` or an ISO date. Cloudflare limits how far
  back and how wide a query can go depending on the plan; a window that's too large comes back
  as an API error.
- `--json` prints `{ project, since, until, zone, hostnames: [{ hostname, requests, bytes, status, classes }], total }`.
- It's one query: `httpRequestsAdaptiveGroups` on the tunnel domain's zone, filtered by
  `clientRequestHTTPHost_in` and the time window, grouped by host and `edgeResponseStatus`.
  Adaptive datasets are sampled, so numbers are estimates for busy sites.

## Token permission

Add **Zone > Analytics > Read** (for the tunnel domain's zone) to the API token. Without it the
query fails with an authorization error, and burrow says which permission is missing.
