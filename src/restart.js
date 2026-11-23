import * as cmd from './commands.js';
import { localProjects, runningPid } from './process.js';
import { isShare, restartShare } from './share.js';

// `burrow restart [project]`: re-sync and restart one project's connector.
// Without a project: every connector that is currently running, shares included
// (see restartShare for how a share is restarted). `--no-hooks` (opts.hooks === false)
// skips pre_up/post_up, as with `burrow up --no-hooks`.
export async function restart(projectArg, opts = {}) {
  if (projectArg && !opts.file && isShare(projectArg)) {
    await restartShare(projectArg, opts);
    return;
  }
  if (projectArg || opts.file) {
    await cmd.up(projectArg, opts);
    return;
  }
  const running = localProjects().filter((p) => runningPid(p));
  if (!running.length) {
    console.log('No running burrow connectors to restart.');
    return;
  }
  let failed = 0;
  for (const project of running) {
    console.log(`== ${project}`);
    try {
      if (isShare(project)) await restartShare(project, { dryRun: opts.dryRun });
      else await cmd.up(project, { dryRun: opts.dryRun, hooks: opts.hooks });
    } catch (e) {
      failed++;
      console.error(`burrow: ${project}: ${e.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}
