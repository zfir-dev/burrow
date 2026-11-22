# burrow edit

```sh
burrow edit [project] [-f <tunnel.yml>] [--no-apply] [--yes] [--dry-run]
```

Opens the project's `tunnel.yml` in your editor, checks it when you save, and offers to
apply it if the project is running.

- **Which file**: `-f <path>`, else `./tunnel.yml` (when it belongs to `project`), else the
  file remembered by the last `burrow up <project>`. A broken file can still be opened.
- **Which editor**: `$VISUAL`, then `$EDITOR` (arguments are fine, e.g. `EDITOR="code --wait"`),
  then `vi`, then `nano`.
- **Validation**: burrow edits a private temporary copy. The real `tunnel.yml` is only
  replaced when the new text passes the same checks as `burrow up`. If it doesn't, burrow
  prints the error and asks whether to re-open the editor; answering no (or running without
  a terminal) leaves `tunnel.yml` untouched and tells you where your edits were kept.
  Quitting the editor with a non-zero exit (e.g. `:cq` in vi) also discards the change.
- **Applying**: if the project's cloudflared is running, burrow asks
  `Apply the change now (burrow up)?`. `--yes` applies without asking, `--no-apply` never
  applies, and `--dry-run` applies as `burrow up --dry-run`. Without a terminal and without
  `--yes` it only prints the `burrow up -f …` command to run.
- Renaming `project:` keeps the old tunnel; burrow tells you to `burrow destroy <old>`.

```sh
burrow edit acme-shop            # edit, then answer the apply prompt
burrow edit --no-apply           # ./tunnel.yml, save only
EDITOR=nano burrow edit -f ~/code/todo-api/tunnel.yml --yes
```
