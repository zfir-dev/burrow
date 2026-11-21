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
- `ExecStop` runs `burrow down`
- `PATH`, `BURROW_CONFIG` and `BURROW_STATE_DIR` are copied into the unit so it finds
  `cloudflared` and your config

User units only start at boot without a login session when lingering is on. `install` and
`status` tell you when it isn't, and the fix is `loginctl enable-linger $USER`.

`burrow autostart [projects...]` is what the unit runs; `--dry-run` shows the list.
For tests, `BURROW_SYSTEMD_DIR` and `BURROW_SYSTEMCTL` override the unit directory and
the `systemctl` binary.
