// burrow-ai wire protocol, vendored from the burrow-ai service (packages/protocol there).
// Every message in both directions is validated; anything else is dropped. The connector
// only ever performs the operations in OPS, with the argument shapes below. There is no
// "run this command" message.
//
// Keep PROTOCOL_VERSION in step with the service. The connector sends it in "hello"; the
// service closes the socket with code 4003 when it needs a different version, and the
// connector then stops and asks the user to update burrow-cli.
export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 256 * 1024;
// WebSocket close codes the service uses.
export const CloseCode = Object.freeze({
  REPLACED: 4000, // another connector with the same device token connected
  REVOKED: 4001, // the device was removed on the server
  HELLO_EXPECTED: 4002, // no hello within 10 s
  PROTOCOL_MISMATCH: 4003, // the server needs another PROTOCOL_VERSION
});

// Error codes an agent can act on. Stable: they are part of the service's MCP contract.
export const ErrorCode = Object.freeze({
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  DEVICE_OFFLINE: 'DEVICE_OFFLINE',
  DEVICE_AMBIGUOUS: 'DEVICE_AMBIGUOUS',
  LIMIT_REACHED: 'LIMIT_REACHED',
  NAME_TAKEN: 'NAME_TAKEN',
  NAME_INVALID: 'NAME_INVALID',
  NOT_ALLOWED: 'NOT_ALLOWED',
  PORT_NOT_ALLOWED: 'PORT_NOT_ALLOWED',
  TTL_TOO_LONG: 'TTL_TOO_LONG',
  TUNNEL_NOT_FOUND: 'TUNNEL_NOT_FOUND',
  PAIRING_INVALID: 'PAIRING_INVALID',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  CONNECTOR_ERROR: 'CONNECTOR_ERROR',
  BURROW_ERROR: 'BURROW_ERROR',
  INTERNAL: 'INTERNAL',
});
export const ERROR_CODES = Object.freeze(Object.values(ErrorCode));

export class ProtocolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ProtocolError';
    this.code = ERROR_CODES.includes(code) ? code : ErrorCode.INTERNAL;
    if (details !== undefined) this.details = details;
  }
  toJSON() {
    return { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) };
  }
}

// DNS label used for tunnel names: lowercase, digits, inner dashes, 1-63 chars.
export const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const isLabel = (s) => typeof s === 'string' && LABEL_RE.test(s);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (s) => typeof s === 'string' && ID_RE.test(s);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, min = -Infinity, max = Infinity) => Number.isInteger(v) && v >= min && v <= max;
const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Operations the server may ask a connector to perform.
export const OPS = Object.freeze(['expose', 'status', 'logs', 'stop', 'list']);
const OP_KEYS = Object.freeze({ expose: ['name', 'port', 'folder'], status: ['name'], logs: ['name', 'lines'], stop: ['name'], list: [] });
const NAME_MSG = 'must be a lowercase DNS label (a-z, 0-9, inner dashes)';

// Validate the arguments of one op. Returns a clean copy; throws ProtocolError(INVALID_ARGUMENT).
export function validateOpArgs(op, args) {
  if (!OPS.includes(op)) throw new ProtocolError(ErrorCode.INVALID_ARGUMENT, `unknown operation "${op}"`);
  const a = args ?? {};
  const issues = [];
  if (!isObject(a)) issues.push('args: expected an object');
  else {
    const extra = Object.keys(a).filter((k) => !OP_KEYS[op].includes(k));
    if (extra.length) issues.push(`args: unrecognized key(s) ${extra.map((k) => `"${k}"`).join(', ')}`);
    if (OP_KEYS[op].includes('name') && !isLabel(a.name)) issues.push(`name: ${NAME_MSG}`);
    if (op === 'expose') {
      if (a.port !== undefined && !isInt(a.port, 1, 65535)) issues.push('port: expected an integer from 1 to 65535');
      if (a.folder !== undefined && !isStr(a.folder, 1, 4096)) issues.push('folder: expected a path of 1 to 4096 characters');
      if ((a.port === undefined) === (a.folder === undefined)) issues.push('args: pass exactly one of port or folder');
    }
    if (op === 'logs' && !isInt(a.lines, 1, 1000)) issues.push('lines: expected an integer from 1 to 1000');
  }
  if (issues.length) throw new ProtocolError(ErrorCode.INVALID_ARGUMENT, `${op}: ${issues.join('; ')}`);
  const clean = {};
  for (const k of OP_KEYS[op]) if (a[k] !== undefined) clean[k] = a[k];
  return clean;
}

// Message validators: return a clean copy (unknown keys dropped) or null.
export function serverMessage(m) {
  if (!isObject(m)) return null;
  if (m.type === 'welcome') {
    return isInt(m.protocol) && isId(m.deviceId) && isInt(m.heartbeatMs, 1)
      ? { type: 'welcome', protocol: m.protocol, deviceId: m.deviceId, heartbeatMs: m.heartbeatMs } : null;
  }
  if (m.type === 'call') return isId(m.id) && OPS.includes(m.op) ? { type: 'call', id: m.id, op: m.op, args: m.args } : null;
  if (m.type === 'ping') return isNum(m.ts) ? { type: 'ping', ts: m.ts } : null;
  return null;
}

export function connectorMessage(m) {
  if (!isObject(m)) return null;
  if (m.type === 'hello') {
    const ok = isInt(m.protocol) && isStr(m.connectorVersion, 0, 64) && (m.burrowVersion === null || isStr(m.burrowVersion, 0, 64))
      && (m.platform === undefined || isStr(m.platform, 0, 64));
    return ok ? { type: 'hello', protocol: m.protocol, connectorVersion: m.connectorVersion, burrowVersion: m.burrowVersion, ...(m.platform !== undefined ? { platform: m.platform } : {}) } : null;
  }
  if (m.type === 'result') {
    const e = m.error;
    const errOk = e === undefined || (isObject(e) && isStr(e.code, 0, 64) && isStr(e.message, 0, 4000));
    if (!isId(m.id) || typeof m.ok !== 'boolean' || !errOk) return null;
    return { type: 'result', id: m.id, ok: m.ok, ...(m.data !== undefined ? { data: m.data } : {}), ...(e !== undefined ? { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } } : {}) };
  }
  if (m.type === 'progress') return isId(m.id) && isStr(m.message, 0, 2000) ? { type: 'progress', id: m.id, message: m.message } : null;
  if (m.type === 'pong') return isNum(m.ts) ? { type: 'pong', ts: m.ts } : null;
  return null;
}

// Parse one raw WebSocket frame with one of the validators above.
// Returns { ok: true, value } or { ok: false, error }.
export function parseMessage(validate, raw) {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) return { ok: false, error: 'message too large' };
  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, error: 'not JSON' }; }
  const value = validate(json);
  return value ? { ok: true, value } : { ok: false, error: `not a valid ${typeof json?.type === 'string' ? `"${json.type.slice(0, 32)}" ` : ''}message` };
}

// burrow names a share "share-<label>"; the connector only touches those.
export const shareProject = (label) => {
  if (!isLabel(label)) throw new ProtocolError(ErrorCode.NAME_INVALID, `invalid name "${label}"`);
  return `share-${label}`;
};
