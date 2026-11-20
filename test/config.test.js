import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, TEMPLATE } from '../src/config.js';

test('parseEnv handles comments, quotes and export', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nexport B="two"\nC=\'3\'\n\nbad line\n'), { A: '1', B: 'two', C: '3' });
});

test('template lists the required keys empty', () => {
  const env = parseEnv(TEMPLATE);
  for (const k of ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_ZONE_ID', 'BURROW_DOMAIN']) assert.equal(env[k], '');
});
