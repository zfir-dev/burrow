# burrow update

```sh
burrow update            # update in place
burrow update --check    # only report whether something newer exists
burrow update --dry-run  # print what would run
```

burrow works out how it was installed and updates the same way:

| Installed as | `--check` | `burrow update` |
| ------------ | --------- | --------------- |
| a **git checkout** (`git clone` + `npm link`) | `git fetch`, then lists the commits on the upstream branch that you don't have, and the new version if `package.json` changed | refuses if tracked files have local changes or the branch has diverged, else `git pull --ff-only` and `npm install` |
| a **global npm install** from the registry (`npm install -g burrow-cli`) | `npm view burrow-cli version`, compared with the installed version | `npm install -g burrow-cli@latest --prefix <the same prefix>` (skipped when already up to date; `--force` reinstalls) |
| a **global npm install** from git (`npm install -g github:zfir-dev/burrow-cli`) | compares the commit npm recorded at install time with `git ls-remote` of the source | `npm install -g <source> --prefix <the same prefix>` (skipped when already up to date; `--force` reinstalls) |

A registry install ignores the git source below unless `BURROW_UPDATE_SOURCE` is set. The source for git-sourced npm installs is, in order: `BURROW_UPDATE_SOURCE` (any npm git spec, e.g.
`github:zfir-dev/burrow-cli#main` or `git+ssh://git@github.com/zfir-dev/burrow-cli.git`), the git URL
npm recorded when burrow was installed, then `repository` in `package.json`. Private repos
work with whatever git credentials you already use (SSH keys, a credential helper).

Every git and npm call has a timeout, and git never stops to ask for a password
(`GIT_TERMINAL_PROMPT=0`, SSH in batch mode), so `burrow update` can't hang in a script.
With nvm, a global install belongs to the active Node version.

`burrow update --check --json` prints one JSON object instead of text: `mode` (`git`, `npm` or
`unknown`), `version`, `available` (`true`, `false`, or `null` when it can't tell), `head`,
`latest` (for a registry install, `source` is `npm` and `latest` is the newest version), and for a git checkout `behind`, `ahead`, `commits` and `remoteVersion`. The
dashboard uses it for its update notice (`BURROW_UPDATE_CHECK=off` turns that off).
