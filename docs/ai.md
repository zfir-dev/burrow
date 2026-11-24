# burrow ai: let AI agents use burrow

`burrow ai` connects this machine to **burrow-ai**, a hosted (paid) service that gives AI
agents such as Claude.ai, ChatGPT or Claude Code a remote MCP server. When an agent asks to
put an app online, burrow-ai sends the request to your machine and burrow creates the
share with **your own** Cloudflare account. Your Cloudflare token never leaves this machine.

burrow itself stays free and works without it. Nothing under `burrow ai` runs unless you
log in.

## Quick start

```sh
npm i -g burrow-cli
burrow init                      # if burrow isn't set up yet
burrow ai login                  # paste the one-time code from the burrow-ai dashboard
burrow ai connect                # foreground; Ctrl+C stops it
```

Then add the burrow-ai MCP URL to your agent (the dashboard's MCP page has the snippets) and
ask it to "put the app on port 3000 online as acme-shop".

| Command | What it does |
| ------- | ------------ |
| `burrow ai login [code]` | Pair this machine using a one-time code from the dashboard's Devices page (or from the `create_pairing_code` MCP tool). Prompts for the code when you leave it out. `--server <url>` (default `BURROW_AI_SERVER` or `https://api.burrow-ai.zfir.dev`), `--name <device>` (default: hostname) |
| `burrow ai connect` | Connect out to burrow-ai over a WebSocket and serve your agents' requests. Reconnects with backoff. `--json` logs one JSON object per line |
| `burrow ai connect --install-service` | Write and start a systemd user unit (`burrow-ai-connect.service`) that keeps it running; `--uninstall-service` removes it, `--dry-run` prints the unit |
| `burrow ai status` | The pairing (never the token), the service state and the exposures burrow-ai made on this machine (`--json`) |
| `burrow ai logout` | Delete the stored device token. Also remove the device in the dashboard |

## What an agent can do

The connector runs a fixed list of operations, with validated arguments. There is no
"run this command" message, and anything else from the server is dropped.

| Operation | burrow does |
| --------- | ----------- |
| `expose {name, port}` | `share <port> --name <name> --detach`: tunnel `burrow-share-<name>`, hostname `<name>.<domain>` |
| `expose {name, folder}` | Serves the folder read-only on `127.0.0.1` (GET/HEAD only, no dotfiles, no listings) and shares that port |
| `status {name}` | Like `status share-<name> --json` |
| `logs {name, lines}` | The last lines of that share's cloudflared log, with token-looking text redacted |
| `stop {name}` | Stops that share and deletes its tunnel and DNS record (never a bare `down`) |
| `list` | The exposures burrow-ai made on this machine |

These run in-process with burrow's own code; no child `burrow` process is started.
`status`, `logs` and `stop` only act on names this connector created (recorded in
`~/.local/state/burrow/ai/exposures.json`), so an agent can't touch your own projects or
shares. Shares created this way show up in the dashboard and in the event history with the
detail `burrow ai`.

## Local policy

`~/.config/burrow/ai/policy.json` (optional) adds limits on top of the server's:

```json
{ "folderRoots": ["/home/me/sites"], "denyPorts": [5432, 6379], "allowPorts": [3000, 5173] }
```

Defaults: folders under your home folder (never the home folder itself or a hidden folder),
ports 22, 3306, 5432, 6379, 7070 and 27017 denied, every other port allowed.

## Files

| Path | What |
| ---- | ---- |
| `~/.config/burrow/ai/device.json` | Server URL, device id and name, and the device token. Mode 600 in a 700 folder. `BURROW_AI_CONFIG_DIR` moves it |
| `~/.config/burrow/ai/policy.json` | Optional local policy |
| `~/.local/state/burrow/ai/exposures.json` | Exposures made through burrow-ai (mode 600). `BURROW_AI_STATE_DIR` moves it |

## Protocol version

The connector speaks burrow-ai protocol version 1 and sends it in its first message. When
the service needs another version it closes the connection (code 4003), and
`burrow ai connect` stops with a message to update: `npm i -g burrow-cli@latest`.

## macOS

`--install-service` writes a systemd unit, so it's Linux only. On macOS, save this as
`~/Library/LaunchAgents/dev.burrow.ai-connect.plist` (adjust the node and burrow paths from
`which node` and `which burrow`) and run `launchctl load ~/Library/LaunchAgents/dev.burrow.ai-connect.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.burrow.ai-connect</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/bin/burrow</string>
    <string>ai</string>
    <string>connect</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/burrow-ai-connect.log</string>
  <key>StandardErrorPath</key><string>/tmp/burrow-ai-connect.log</string>
</dict>
</plist>
```
