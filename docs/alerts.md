# burrow watch (alerts)

```sh
burrow watch [projects...] [--interval 60] [--debounce 2] [--once] [--dry-run]
burrow watch --install-service [--interval 60] [--debounce 2]
burrow watch --uninstall-service
```

`burrow watch` checks each project every `--interval` seconds and sends an alert when its
health changes:

| Status | When |
| ------ | ---- |
| `down` | the local cloudflared isn't running (pid file left behind = it exited or crashed), or the tunnel is `down`/`inactive` or missing on Cloudflare |
| `degraded` | the tunnel is `degraded`, or a service in `tunnel.yml` has nothing listening on its local port |
| `ok` | none of the above; going back to `ok` sends a "recovered" alert |

- Without project names it watches every project that has a pid file. `burrow down` removes
  the pid file, so a project you stopped on purpose is no longer watched and doesn't alert.
- **Debounce**: a new status has to show up `--debounce` checks in a row (default 2) before
  it alerts, so one slow check doesn't page you. The state lives in
  `~/.local/state/burrow/watch/state.json`, so debouncing works across `--once` runs too.
- `--once` checks once and exits, for cron:

  ```cron
  */5 * * * * burrow watch --once
  ```

- `--dry-run` prints alerts instead of sending them.
- Cloudflare API errors skip the tunnel check for that round; they never mark a project down.

## Channels

Set these in `~/.config/burrow/config.env` (or the environment). Both are optional and can be
used together. They're treated as secrets and never printed.

| Setting | What it does |
| ------- | ------------ |
| `BURROW_ALERT_WEBHOOK` | POSTs JSON to a URL. Slack incoming webhooks (`hooks.slack.com`) get `{ "text": … }`, Discord webhooks get `{ "content": … }`, anything else gets `{ text, content, project, status, previous, problems, hostnames, at }` |
| `BURROW_ALERT_NTFY` | an [ntfy](https://ntfy.sh) topic (`burrow-alerts`, sent to `https://ntfy.sh/<topic>`) or a full topic URL on your own server; the title says the project and status, `down` is sent with high priority |
| `BURROW_ALERT_NTFY_TOKEN` | optional ntfy access token (sent as `Authorization: Bearer …`) |

Each request times out after 10 s; a failed delivery is printed and the watch carries on.

## systemd

`burrow watch --install-service` writes `~/.config/systemd/user/burrow-watch.service`
(`Type=simple`, `Restart=on-failure`, running `burrow watch --interval N --debounce D`) and
runs `systemctl --user enable --now` on it. `--uninstall-service` disables and removes it.
It sits next to the unit from `burrow service install` and uses the same config and state
paths. Run `loginctl enable-linger $USER` so it runs without an open session.
