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

| Option | Meaning |
| ------ | ------- |
| `--dry-run` | List the orphans, delete nothing |
| `-y, --yes` | Don't ask (required in non-interactive shells) |
| `--include-active` | Also prune tunnels with live connections |
