import { dirname, join } from 'node:path';
import { configPath, stateDir as burrowStateDir } from '../config.js';

// Next to burrow's own config and state:
//   ~/.config/burrow/ai/device.json   device token (mode 600, dir 700)
//   ~/.config/burrow/ai/policy.json   optional local policy
//   ~/.local/state/burrow/ai/         exposures.json, connect.log
// BURROW_AI_CONFIG_DIR / BURROW_AI_STATE_DIR override them.
export const configDir = (env = process.env) => env.BURROW_AI_CONFIG_DIR || join(dirname(configPath()), 'ai');
export const stateDir = (env = process.env) => env.BURROW_AI_STATE_DIR || join(burrowStateDir(), 'ai');
export const credentialsFile = (env = process.env) => join(configDir(env), 'device.json');
export const policyFile = (env = process.env) => join(configDir(env), 'policy.json');

// The hosted burrow-ai service. BURROW_AI_SERVER or --server override it.
export const DEFAULT_SERVER = 'https://api-burrow-ai.zfir.dev';
export const defaultServer = (env = process.env) => env.BURROW_AI_SERVER || DEFAULT_SERVER;
