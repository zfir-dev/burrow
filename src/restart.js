import * as cmd from './commands.js';
import { localProjects, runningPid } from './process.js';

// `burrow restart [project]`: re-sync and restart one project's connector.
// Without a project: every connector that is currently running.
export async function restart(projectArg, opts = {}) {
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
      await cmd.up(project, { dryRun: opts.dryRun });
    } catch (e) {
      failed++;
      console.error(`burrow: ${project}: ${e.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}
