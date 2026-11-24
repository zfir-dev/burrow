import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION, MAX_MESSAGE_BYTES, ErrorCode, ERROR_CODES, ProtocolError, OPS, validateOpArgs,
  serverMessage, connectorMessage, parseMessage, shareProject, isLabel,
} from '../src/ai/protocol.js';

test('protocol version and the fixed operation list', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.deepEqual([...OPS], ['expose', 'status', 'logs', 'stop', 'list']);
  assert.ok(ERROR_CODES.includes('TUNNEL_NOT_FOUND'));
  assert.equal(new ProtocolError('NOPE', 'x').code, ErrorCode.INTERNAL);
  assert.deepEqual(new ProtocolError('NAME_TAKEN', 'busy').toJSON(), { code: 'NAME_TAKEN', message: 'busy' });
});

test('validateOpArgs accepts the documented shapes and returns clean copies', () => {
  assert.deepEqual(validateOpArgs('expose', { name: 'acme-shop', port: 3100 }), { name: 'acme-shop', port: 3100 });
  assert.deepEqual(validateOpArgs('expose', { name: 'acme-shop', folder: '/srv/www' }), { name: 'acme-shop', folder: '/srv/www' });
  assert.deepEqual(validateOpArgs('logs', { name: 'todo-api', lines: 50 }), { name: 'todo-api', lines: 50 });
  assert.deepEqual(validateOpArgs('list', undefined), {});
  assert.deepEqual(validateOpArgs('stop', { name: 'a' }), { name: 'a' });
});

test('validateOpArgs rejects anything else with INVALID_ARGUMENT', () => {
  const bad = [
    ['exec', { cmd: 'id' }],
    ['expose', { name: 'x; rm -rf ~', port: 1 }],
    ['expose', { name: '--all', port: 3100 }],
    ['expose', { name: 'Acme', port: 3100 }],
    ['expose', { name: 'ok', port: '3100' }],
    ['expose', { name: 'ok', port: 0 }],
    ['expose', { name: 'ok', port: 70000 }],
    ['expose', { name: 'ok', port: 1.5 }],
    ['expose', { name: 'ok' }],
    ['expose', { name: 'ok', port: 3100, folder: '/srv' }],
    ['expose', { name: 'ok', folder: '' }],
    ['expose', { name: 'ok', port: 3100, cmd: 'id' }],
    ['logs', { name: 'ok' }],
    ['logs', { name: 'ok', lines: 1001 }],
    ['stop', { name: 'ok', extra: 1 }],
    ['stop', []],
    ['list', { all: true }],
    ['status', 'share-ok'],
  ];
  for (const [op, args] of bad) assert.throws(() => validateOpArgs(op, args), { code: 'INVALID_ARGUMENT' }, `${op} ${JSON.stringify(args)}`);
});

test('server and connector message validators', () => {
  assert.deepEqual(serverMessage({ type: 'welcome', protocol: 1, deviceId: 'dev_1', heartbeatMs: 15000, x: 1 }), { type: 'welcome', protocol: 1, deviceId: 'dev_1', heartbeatMs: 15000 });
  assert.deepEqual(serverMessage({ type: 'call', id: 'c1', op: 'list', args: {} }), { type: 'call', id: 'c1', op: 'list', args: {} });
  assert.equal(serverMessage({ type: 'call', id: 'c1', op: 'shell', args: {} }), null);
  assert.equal(serverMessage({ type: 'call', id: 'bad id', op: 'list' }), null);
  assert.equal(serverMessage({ type: 'exec', cmd: 'id' }), null);
  assert.equal(serverMessage({ type: 'welcome', protocol: 1, deviceId: 'd', heartbeatMs: 0 }), null);
  assert.equal(serverMessage([]), null);
  assert.ok(connectorMessage({ type: 'hello', protocol: 1, connectorVersion: '0.2.0', burrowVersion: null }));
  assert.equal(connectorMessage({ type: 'hello', protocol: '1', connectorVersion: '0.2.0', burrowVersion: null }), null);
  assert.deepEqual(connectorMessage({ type: 'result', id: 'c1', ok: false, error: { code: 'NAME_TAKEN', message: 'm' } }), { type: 'result', id: 'c1', ok: false, error: { code: 'NAME_TAKEN', message: 'm' } });
  assert.equal(connectorMessage({ type: 'result', id: 'c1', ok: 'yes' }), null);
  assert.deepEqual(connectorMessage({ type: 'pong', ts: 1 }), { type: 'pong', ts: 1 });
});

test('parseMessage drops non-JSON, oversized and invalid frames', () => {
  assert.equal(parseMessage(serverMessage, '{{{').ok, false);
  assert.equal(parseMessage(serverMessage, JSON.stringify({ type: 'ping', ts: 1, pad: 'x'.repeat(MAX_MESSAGE_BYTES) })).error, 'message too large');
  assert.match(parseMessage(serverMessage, '{"type":"exec"}').error, /not a valid "exec" message/);
  assert.deepEqual(parseMessage(serverMessage, Buffer.from('{"type":"ping","ts":5}')), { ok: true, value: { type: 'ping', ts: 5 } });
});

test('shareProject only builds share-<label> names', () => {
  assert.equal(shareProject('acme-shop'), 'share-acme-shop');
  assert.throws(() => shareProject('../x'), { code: 'NAME_INVALID' });
  assert.equal(isLabel('-x'), false);
});
