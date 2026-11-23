# burrow service

Installs a **systemd user unit** that brings your tunnels up at boot.

```sh
burrow service install          # projects marked autostart (re-read at every boot)
burrow service install --projects acme-shop,todo-api --now
burrow service status
burrow service uninstall
```

Which projects start:

- every remembered project whose `tunnel.yml` has `autostart: true`:

  ```yaml
  project: acme-shop
  autostart: true
  services:
    - name: app
      url: http://localhost:3100
  ```

- plus `BURROW_AUTOSTART=acme-shop,todo-api` in `~/.config/burrow/config.env`.
- `--projects a,b` on `install` puts a fixed list in the unit instead.
- `burrow` (the dashboard) is allowed in the list; it runs `burrow dashboard up`.

The unit (`~/.config/systemd/user/burrow.service`) is a `Type=oneshot` service with
`RemainAfterExit=yes`:

- `ExecStart` runs `burrow autostart` (with the same Node binary you used to install it), which runs `burrow up` for each project
- `ExecStop` runs `burrow down --keep-shares`: projects stop, temporary shares keep running
- `KillMode=process`: after `ExecStop`, systemd kills only the unit's main process, not every
  process it started. Connectors, the dashboard, shares and their expiry watchers are detached
  children of the unit, so without it `systemctl --user stop|restart burrow` (or an upgrade
  that restarts it) would kill them all, shares included.
- when `systemd-run` is installed, `ExecStart` is `systemd-run --user --scope ... burrow autostart`.
  The boot command (and so every connector, dashboard, share and expiry watcher it starts) runs in
  its own transient scope, outside the unit's cgroup. With `KillMode=process` alone systemd would
  warn about those leftover processes on every stop or restart; with the scope it has none to
  warn about. Without `systemd-run` the unit is written as before (no scope).
  `ExecStop` is not scoped.
- `PATH`, `BURROW_CONFIG` and `BURROW_STATE_DIR` are copied into the unit so it finds
  `cloudflared` and your config

### Upgrading an older unit

Units written before this change have no `KillMode=process` and stop with plain `burrow down`.
`burrow service status` says **Outdated** for them, and the dashboard's boot bar shows
*outdated* with an **Update** button. `burrow service install` (or **Update**) rewrites the unit
and reloads systemd; it doesn't restart anything, and the new stop behaviour applies from the
next stop or restart.

A unit that has `KillMode=process` but no scope is also reported **Outdated** when `systemd-run`
is available (different message: it only affects the leftover-process warning). Run
`burrow service install` to update it.

`burrow watch --install-service` starts no child processes, so its unit keeps the default.

User units only start at boot without a login session when lingering is on. `install` and
`status` tell you when it isn't, and the fix is `loginctl enable-linger $USER`.

`burrow autostart [projects...]` is what the unit runs; `--dry-run` shows the list.
For tests, `BURROW_SYSTEMD_DIR` and `BURROW_SYSTEMCTL` override the unit directory and
the `systemctl` binary, and `BURROW_SYSTEMD_RUN` the `systemd-run` binary (`none` turns the scope off).
