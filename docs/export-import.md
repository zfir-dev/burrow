# burrow export / burrow import

Move your project configs to another machine (or back them up).

```sh
burrow export projects.yml                 # every remembered project
burrow export --project acme-shop,blog     # some projects, to stdout
burrow export projects.json                # JSON when the file ends in .json (or --json)

burrow import projects.yml                 # -> ~/.config/burrow/projects/<project>.tunnel.yml
burrow import projects.yml --dir ~/tunnels --dry-run
burrow import projects.yml --force         # replace existing files / remembered paths
```

- **Export** reads the `tunnel.yml` of every project burrow remembers (the ones you've run
  `burrow up` on). Shares are left out.
- Only tunnel.yml fields are copied: `project`, `autostart`, `services[].name/root/url/originRequest`
  and `paths[].path/url/originRequest`. The config file (API token, account ID, dashboard
  password) is **never** read into the bundle, and import drops any other keys too.
- **Import** validates each project, writes `<dir>/<project>.tunnel.yml` and remembers it, so
  `burrow up <project>` works from any directory. Existing files and projects already known
  at another path are skipped unless you pass `--force`.

Bundle format:

```yaml
burrow: projects
version: 1
exportedAt: 2026-01-01T00:00:00.000Z
projects:
  - project: acme-shop
    services:
      - name: app
        url: http://localhost:3100
```
