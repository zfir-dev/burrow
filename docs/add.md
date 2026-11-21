# burrow add

Creates a `tunnel.yml` in the current directory (or at `-f <path>`).

## Interactive

```console
$ burrow add
Project name [acme-shop]:
App port or URL (root hostname, empty for none): 3100
  Extra path on the app, e.g. /api (empty to finish): /auth/v1
  Port or URL for /auth/v1: 54321
  Extra path on the app, e.g. /api (empty to finish):
Sub-service name, e.g. mail (empty to finish): mail
  Port or URL for mail: 54324
Sub-service name, e.g. mail (empty to finish):
Wrote /home/me/code/acme-shop/tunnel.yml
  app        https://acme-shop.example.dev
  mail       https://mail-acme-shop.example.dev
Next: burrow up
```

The project name defaults to the directory name.

## Non-interactive

```sh
burrow add acme-shop --app 3100 \
  --path /auth/v1=54321 --path /rest/v1=54321 \
  --service mail=54324 --service studio=54323
```

| Option | Meaning |
| ------ | ------- |
| `--app <port\|url>` | Root service (`<project>.<domain>`) |
| `--path <prefix=port\|url>` | Extra path rule on the app (repeatable) |
| `--service <name=port\|url>` | Sub-service `<name>-<project>.<domain>` (repeatable) |
| `-f, --file <path>` | Where to write (default `./tunnel.yml`) |
| `--force` | Overwrite an existing file |
| `-y, --yes` | Never prompt; fail if no services were given |

A bare port means `http://localhost:<port>`; `host:port` means `http://host:port`.
The file is validated with the same rules as `burrow up` before it is written.
When stdin isn't a terminal and no flags are given, `burrow add` fails instead of waiting for input.
