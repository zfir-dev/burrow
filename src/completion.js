import { readdirSync } from 'node:fs';
import { stateDir } from './config.js';
import { findProjectFile, loadProjectFile, DASHBOARD_PROJECT } from './project.js';

// Project names for completion: remembered/running projects, ./tunnel.yml, the dashboard.
export function projectNames() {
  const names = new Set();
  try {
    for (const f of readdirSync(stateDir())) {
      const m = f.match(/^([a-z0-9][a-z0-9-]*)\.(json|pid)$/);
      if (m) names.add(m[1]);
    }
  } catch {}
  try {
    const file = findProjectFile();
    if (file) names.add(loadProjectFile(file).project);
  } catch {}
  names.add(DASHBOARD_PROJECT);
  return [...names].sort();
}

const ACTIONS = { dashboard: ['up', 'down', 'status'], service: ['install', 'uninstall', 'status'], completion: ['bash', 'zsh'] };

// Describe the commander program: name, description, options, first-argument kind.
export function describe(program) {
  return program.commands
    .filter((c) => !c._hidden)
    .map((c) => {
      const args = c.registeredArguments || c._args || [];
      const first = args[0] ? args[0].name() : '';
      return {
        name: c.name(),
        description: c.description(),
        options: c.options.map((o) => o.long).filter(Boolean).concat('--help'),
        projectArg: first === 'project',
        actions: ACTIONS[c.name()] || [],
      };
    });
}

export function bashScript(cmds) {
  const cases = cmds.map((c) => {
    const opts = c.options.join(' ');
    let words = '';
    if (c.projectArg) words = '$(burrow __complete projects 2>/dev/null)';
    else if (c.actions.length) words = c.actions.join(' ');
    return `    ${c.name})
      if [[ "$cur" == -* ]]; then COMPREPLY=( $(compgen -W "${opts}" -- "$cur") )
      elif [[ $COMP_CWORD -eq 2 ]]; then COMPREPLY=( $(compgen -W "${words}" -- "$cur") )
      fi ;;`;
  }).join('\n');
  return `# burrow bash completion. Load it with:  source <(burrow completion bash)
_burrow() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=()
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${cmds.map((c) => c.name).join(' ')} --help --version" -- "$cur") )
    return 0
  fi
  case "\${COMP_WORDS[1]}" in
${cases}
  esac
  return 0
}
complete -F _burrow burrow
`;
}

const zq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function zshScript(cmds) {
  const list = cmds.map((c) => `    ${zq(`${c.name}:${c.description.replace(/:/g, '\\:')}`)}`).join('\n');
  const cases = cmds.map((c) => {
    const opts = c.options.map(zq).join(' ');
    let words = '';
    if (c.projectArg) words = 'compadd -- ${(f)"$(burrow __complete projects 2>/dev/null)"}';
    else if (c.actions.length) words = `compadd -- ${c.actions.join(' ')}`;
    return `    ${c.name})
      if [[ $words[CURRENT] == -* ]]; then compadd -- ${opts}
      elif (( CURRENT == 3 )); then ${words || ':'}
      fi ;;`;
  }).join('\n');
  return `#compdef burrow
# burrow zsh completion. Load it with:  source <(burrow completion zsh)
# or save it as _burrow in a directory on your $fpath.
_burrow() {
  local -a cmds
  cmds=(
${list}
  )
  if (( CURRENT == 2 )); then
    _describe 'burrow command' cmds
    return
  fi
  case $words[2] in
${cases}
  esac
}
if [[ $zsh_eval_context[-1] == loadautofunc ]]; then
  _burrow "$@"
else
  compdef _burrow burrow
fi
`;
}

export function completion(shell, program) {
  const cmds = describe(program);
  if (shell === 'bash') return process.stdout.write(bashScript(cmds));
  if (shell === 'zsh') return process.stdout.write(zshScript(cmds));
  throw new Error(`Unsupported shell "${shell}" (use bash or zsh)`);
}

export function complete(what) {
  if (what === 'projects') for (const p of projectNames()) console.log(p);
}
