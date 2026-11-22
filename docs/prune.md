# burrow prune

Finds burrow leftovers on Cloudflare and deletes them after asking.

```console
$ burrow prune
Skipping burrow-todo-api: no local state, but it has 2 live connection(s) (another machine?). Use --include-active to prune it.
Orphans:
  tunnel burrow-old-blog (4f0c…)
  DNS CNAME ghost.example.dev -> 9a1b….cfargotunnel.com (burrow:ghost)
  DNS CNAME old-blog.example.dev -> 4f0c….cfargotunnel.com (burrow:old-blog)
Delete 1 tunnel(s) and 2 DNS record(s)? [y/N]
```

What counts as an orphan:

- a **tunnel** `burrow-<project>` with no local state for `<project>` (no
  `~/.local/state/burrow/<project>.json` or `.pid`). Tunnels that still have live
  connections are skipped, because they are probably running on another machine;
  `--include-active` prunes them too.
- a **DNS record** with comment `burrow:<project>` whose tunnel doesn't exist, that points
  to a different tunnel than `burrow-<project>`, or that belongs to an orphan tunnel.

Records without a `burrow:` comment are never touched.

## Queued DNS deletions

`burrow destroy` looks for a project's DNS records in every zone burrow knows. If one of those
zones can't be read at that moment (the token lost access to it, a Cloudflare error), destroy
warns, still deletes the tunnel, and queues the deletion in
`~/.local/state/burrow/cleanup/pending.json` (mode 600):

```console
$ burrow destroy acme-shop
burrow: warning: acme-shop: couldn't read DNS in example.org (403 Authentication error); its records there are queued for deletion. Run "burrow prune" to retry.
acme-shop: deleted tunnel burrow-acme-shop (…)
```

`burrow prune` retries queued deletions first, without asking again (you already asked for
them), then looks for orphans as usual. An entry that still fails stays queued and prune exits
with 1; `--dry-run` only lists them. If the project has been set up again in the meantime its
records are kept and the entry is dropped. The dashboard's **Cleanup** panel shows the same
queue with a **Retry now** button. A zone that can't be read during prune itself is skipped
with a warning instead of stopping the whole run.

| Option | Meaning |
| ------ | ------- |
| `--dry-run` | List the orphans, delete nothing |
| `-y, --yes` | Don't ask (required in non-interactive shells) |
| `--include-active` | Also prune tunnels with live connections |
