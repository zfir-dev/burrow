// Panel: signed-in sessions and optional two-factor sign-in (TOTP, see ../totp.js).
// Lists sessions by an opaque handle (a hash; session ids never leave the server), signs
// one out, all others, or everywhere. Two-factor setup shows the secret and QR code once;
// it is turned on only after a valid code, and turning it off needs a current code.
import { createHash } from 'node:crypto';
import { RateLimiter } from '../auth.js';
import { beginSetup, confirmSetup, disable, readTotp, totpEnabled, verifyCode } from '../totp.js';

export const order = 92;
const handleOf = (id) => createHash('sha256').update(`burrow-session-handle\0${id}`).digest('hex').slice(0, 16);
const codeLimiter = new RateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });

function view(ctx) {
  const cur = ctx.sessions.current();
  const list = ctx.sessions.list()
    .map((s) => ({
      handle: handleOf(s.id), current: s.id === cur, createdAt: s.createdAt || null, lastSeen: s.lastSeen || null,
      expiresAt: s.exp, ip: s.ip || null, agent: s.agent || '',
    }))
    .sort((a, b) => (b.current - a.current) || (b.lastSeen || 0) - (a.lastSeen || 0));
  const t = readTotp();
  return { sessions: list, twoFactor: { enabled: !!t.enabled, enabledAt: t.enabledAt || null, pending: !t.enabled && !!t.pending } };
}

export async function route(ctx) {
  const { method, path } = ctx;
  if (!path.startsWith('/api/sessions') && !path.startsWith('/api/two-factor')) return false;
  if (method === 'GET' && path === '/api/sessions') return ctx.json(200, view(ctx)) ?? true;
  if (method !== 'POST') return false;
  const body = await ctx.readJson();
  if (!body) return ctx.json(400, { error: 'invalid JSON' }) ?? true;
  const cur = ctx.sessions.current();

  if (path === '/api/sessions/revoke') {
    const target = ctx.sessions.list().find((s) => handleOf(s.id) === String(body.handle || ''));
    if (!target) return ctx.json(404, { error: 'no such session' }) ?? true;
    ctx.sessions.revoke(target.id);
    ctx.log(`signed out a session (requested from ${ctx.clientIp})`);
    const self = target.id === cur;
    return ctx.json(200, { ok: true, signedOut: self }, self ? { 'Set-Cookie': ctx.sessions.clearCookie() } : undefined) ?? true;
  }
  if (path === '/api/sessions/revoke-others' || path === '/api/sessions/revoke-all') {
    const all = path.endsWith('all');
    if (all && body.confirm !== true) return ctx.json(400, { error: 'confirm signing out everywhere (confirm: true)' }) ?? true;
    let n = 0;
    for (const s of ctx.sessions.list()) if (all || s.id !== cur) { ctx.sessions.revoke(s.id); n++; }
    ctx.log(`signed out ${n} session(s)${all ? ' everywhere' : ''} (requested from ${ctx.clientIp})`);
    ctx.events.emit('event', { action: all ? 'sign-out everywhere' : 'sign-out others', ok: true, detail: `${n} session(s)` });
    return ctx.json(200, { ok: true, revoked: n, signedOut: all }, all ? { 'Set-Cookie': ctx.sessions.clearCookie() } : undefined) ?? true;
  }

  // Two-factor. Code checks share a per-IP limit (5 wrong codes / 15 min).
  const limited = () => {
    const lim = codeLimiter.check(ctx.clientIp);
    if (lim.allowed) return false;
    ctx.json(429, { error: `Too many wrong codes. Try again in ${Math.ceil(lim.retryAfter / 60)} min.` }, { 'Retry-After': String(lim.retryAfter) });
    return true;
  };
  if (path === '/api/two-factor/setup') {
    try {
      const s = beginSetup('dashboard');
      ctx.log(`two-factor setup started (requested from ${ctx.clientIp})`);
      // The only response that ever carries the secret.
      return ctx.json(200, { ok: true, secret: s.secret, uri: s.uri }) ?? true;
    } catch (e) { return ctx.json(409, { error: e.message }) ?? true; }
  }
  if (path === '/api/two-factor/enable') {
    if (limited()) return true;
    let ok;
    try { ok = confirmSetup(body.code); } catch (e) { return ctx.json(409, { error: e.message }) ?? true; }
    if (!ok) { codeLimiter.fail(ctx.clientIp); return ctx.json(400, { error: 'That code is not right. Check the time on your phone and try the newest code.' }) ?? true; }
    codeLimiter.reset(ctx.clientIp);
    let n = 0;
    if (body.signOutOthers === true) for (const s of ctx.sessions.list()) if (s.id !== cur) { ctx.sessions.revoke(s.id); n++; }
    ctx.log(`two-factor sign-in turned on (requested from ${ctx.clientIp})`);
    ctx.events.emit('event', { action: 'two-factor on', ok: true, detail: n ? `signed out ${n} other session(s)` : '' });
    return ctx.json(200, { ok: true, ...view(ctx) }) ?? true;
  }
  if (path === '/api/two-factor/disable') {
    if (!totpEnabled()) return ctx.json(409, { error: 'two-factor sign-in is off' }) ?? true;
    if (body.confirm !== true) return ctx.json(400, { error: 'confirm turning two-factor sign-in off (confirm: true)' }) ?? true;
    if (limited()) return true;
    if (!verifyCode(body.code)) { codeLimiter.fail(ctx.clientIp); return ctx.json(400, { error: 'That code is not right, or it was already used: wait for the next one.' }) ?? true; }
    codeLimiter.reset(ctx.clientIp);
    disable();
    ctx.log(`two-factor sign-in turned off (requested from ${ctx.clientIp})`);
    ctx.events.emit('event', { action: 'two-factor off', ok: true });
    return ctx.json(200, { ok: true, ...view(ctx) }) ?? true;
  }
  return false;
}

export const html = {
  toolbar: '<li><button class="secondary outline" @click="openSessions">Sessions</button></li>',
  sections: `
<article x-show="sessionsOpen" class="sessions">
  <header class="logs-head">
    <strong>Sessions</strong><small class="muted">browsers signed in to this dashboard</small>
    <span class="spacer"></span>
    <button class="secondary outline" :disabled="noOtherSessions" @click="revokeOthers">Sign out other sessions</button>
    <button class="danger outline" @click="askSignOutAll">Sign out everywhere</button>
    <button class="secondary outline" @click="closeSessions">Close</button>
  </header>
  <table class="session-list">
    <thead><tr><th>Browser</th><th>IP</th><th>Signed in</th><th>Last active</th><th></th></tr></thead>
    <tbody>
      <template x-for="s in sessionRows" :key="s.handle">
        <tr>
          <td><span x-text="browserName(s)"></span> <span class="badge ok" x-show="s.current">this browser</span></td>
          <td><code x-text="s.ip"></code></td>
          <td><small x-text="sessionAgo(s.createdAt)"></small></td>
          <td><small x-text="sessionAgo(s.lastSeen)"></small></td>
          <td><button class="secondary outline" @click="revokeSession(s)" x-text="revokeLabel(s)"></button></td>
        </tr>
      </template>
    </tbody>
  </table>
  <p><small class="muted">Sessions last 12 hours. Restarting the dashboard or changing its password signs everyone out.</small></p>

  <h4>Two-factor sign-in</h4>
  <div x-show="tfaOff">
    <p><small>Off. With it on, signing in also needs a 6-digit code from an authenticator app (any TOTP app).</small></p>
    <button class="secondary outline" @click="startTfa" x-show="noTfaSetup">Set up two-factor sign-in</button>
    <div x-show="hasTfaSetup" class="tfa-setup">
      <p><small>Scan this with your authenticator app, or enter the key by hand. It is shown only now: once two-factor is on, the dashboard never shows it again.</small></p>
      <p class="qr-img"><img :src="tfaQr" alt="Two-factor setup QR code" width="232" height="232" x-show="hasTfaQr"></p>
      <p><small>Key: <code class="tfa-secret" x-text="tfaSecretGroups"></code></small></p>
      <form class="tfa-form" @submit.prevent="enableTfa">
        <input type="text" x-model="tfaCode" placeholder="6-digit code" aria-label="Code from the app" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required>
        <button type="submit" :aria-busy="tfaBusy" :disabled="tfaBusy">Turn on</button>
        <button type="button" class="secondary" @click="cancelTfa">Cancel</button>
      </form>
      <label><input type="checkbox" x-model="tfaSignOutOthers"> Sign out other sessions</label>
    </div>
  </div>
  <div x-show="tfaOn">
    <p><small><span class="badge ok">on</span> Signing in needs a code from your authenticator app<span x-text="tfaSince"></span>.</small></p>
    <form class="tfa-form" @submit.prevent="askDisableTfa">
      <input type="text" x-model="tfaCode" placeholder="Current 6-digit code" aria-label="Current code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required>
      <button type="submit" class="danger outline">Turn off</button>
    </form>
  </div>
  <p class="error" x-show="hasSessionError" x-text="sessionError"></p>
</article>
<dialog :open="confirmSessOpen">
  <article>
    <header><strong x-text="confirmSessTitle"></strong></header>
    <p x-text="confirmSessText"></p>
    <footer>
      <button class="secondary" @click="closeConfirmSess">Cancel</button>
      <button class="danger" :aria-busy="tfaBusy" @click="runConfirmSess" x-text="confirmSessButton"></button>
    </footer>
  </article>
</dialog>`,
};

export const css = `
.session-list{font-size:.875rem}
.tfa-form{display:flex;gap:.5rem;align-items:center;max-width:520px}.tfa-form input,.tfa-form button{margin:0;width:auto}
.tfa-form input{flex:1}.tfa-secret{word-break:break-all;letter-spacing:.05em}
.sessions .qr-img img{image-rendering:pixelated;background:#fff;padding:8px;border-radius:8px}
`;

export const js = `
burrowPanel(function () {
  var qrLoading = null;
  function loadQr() {
    if (window.qrcode) return Promise.resolve();
    if (!qrLoading) {
      qrLoading = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = '/vendor/qrcode.js';
        s.onload = function () { resolve(); };
        s.onerror = function () { qrLoading = null; reject(new Error('could not load the QR library')); };
        document.head.appendChild(s);
      });
    }
    return qrLoading;
  }
  return {
    sessionsOpen: false, sessionRows: [], twoFactor: { enabled: false, enabledAt: null }, sessionError: '',
    tfaSecret: '', tfaQr: '', tfaCode: '', tfaBusy: false, tfaSignOutOthers: true,
    confirmSessOpen: false, confirmSessKind: '',
    get hasSessionError() { return this.sessionError.length > 0; },
    get noOtherSessions() { return this.sessionRows.filter(function (s) { return !s.current; }).length === 0; },
    get tfaOn() { return !!this.twoFactor.enabled; },
    get tfaOff() { return !this.twoFactor.enabled; },
    get hasTfaSetup() { return this.tfaSecret.length > 0; },
    get noTfaSetup() { return this.tfaSecret.length === 0; },
    get hasTfaQr() { return this.tfaQr.length > 0; },
    get tfaSecretGroups() { return this.tfaSecret.replace(/(.{4})/g, '$1 ').trim(); },
    get tfaSince() { return this.twoFactor.enabledAt ? ' (on since ' + new Date(this.twoFactor.enabledAt).toLocaleString() + ')' : ''; },
    get confirmSessTitle() { return this.confirmSessKind === 'all' ? 'Sign out everywhere?' : 'Turn off two-factor sign-in?'; },
    get confirmSessText() {
      return this.confirmSessKind === 'all'
        ? 'Every browser signed in to this dashboard, including this one, has to sign in again.'
        : 'Signing in will only need the password. You can set it up again later with a new key.';
    },
    get confirmSessButton() { return this.confirmSessKind === 'all' ? 'Sign out everywhere' : 'Turn off'; },
    browserName: function (s) {
      var a = s.agent || '';
      var b = /Edg\\//.test(a) ? 'Edge' : /Firefox\\//.test(a) ? 'Firefox' : /Chrome\\//.test(a) ? 'Chrome' : /Safari\\//.test(a) ? 'Safari' : (a ? a.split(' ')[0] : 'Unknown');
      var os = /Android/.test(a) ? 'Android' : /iPhone|iPad/.test(a) ? 'iOS' : /Mac OS X/.test(a) ? 'macOS' : /Windows/.test(a) ? 'Windows' : /Linux/.test(a) ? 'Linux' : '';
      return b + (os ? ' on ' + os : '');
    },
    sessionAgo: function (t) { return t ? ago(Date.now() - t) + ' ago' : '—'; },
    revokeLabel: function (s) { return s.current ? 'Sign out' : 'Sign out this session'; },
    openSessions: function () { this.sessionsOpen = true; this.loadSessions(); },
    closeSessions: function () { this.sessionsOpen = false; this.cancelTfa(); },
    loadSessions: async function () {
      try { var j = await getJson('/api/sessions'); this.sessionRows = j.sessions; this.twoFactor = j.twoFactor; }
      catch (e) { this.sessionError = e.message; }
    },
    sessPost: async function (url, body) {
      this.sessionError = '';
      var r = await post(url, body || {});
      if (r.status === 401) { location.assign('/login'); throw new Error('signed out'); }
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      if (j.signedOut) { location.assign('/login'); throw new Error('signed out'); }
      return j;
    },
    revokeSession: async function (s) {
      try { await this.sessPost('/api/sessions/revoke', { handle: s.handle }); this.loadSessions(); } catch (e) { this.sessionError = e.message; }
    },
    revokeOthers: async function () {
      try { var j = await this.sessPost('/api/sessions/revoke-others'); this.showToast('✓ signed out ' + j.revoked + ' session(s)', true, 4000); this.loadSessions(); }
      catch (e) { this.sessionError = e.message; }
    },
    askSignOutAll: function () { this.confirmSessKind = 'all'; this.confirmSessOpen = true; },
    askDisableTfa: function () { this.confirmSessKind = 'tfa'; this.confirmSessOpen = true; },
    closeConfirmSess: function () { this.confirmSessOpen = false; },
    runConfirmSess: async function () {
      var kind = this.confirmSessKind;
      this.confirmSessOpen = false;
      if (kind === 'all') { try { await this.sessPost('/api/sessions/revoke-all', { confirm: true }); } catch (e) { this.sessionError = e.message; } return; }
      this.tfaBusy = true;
      try {
        var j = await this.sessPost('/api/two-factor/disable', { code: this.tfaCode, confirm: true });
        this.twoFactor = j.twoFactor; this.tfaCode = '';
        this.showToast('✓ two-factor sign-in is off', true, 5000);
      } catch (e) { this.sessionError = e.message; } finally { this.tfaBusy = false; }
    },
    startTfa: async function () {
      try {
        var j = await this.sessPost('/api/two-factor/setup');
        this.tfaSecret = j.secret; this.tfaCode = ''; this.tfaQr = '';
        await loadQr();
        var q = window.qrcode(0, 'M');
        q.addData(j.uri);
        q.make();
        this.tfaQr = q.createDataURL(4, 2);
      } catch (e) { this.sessionError = e.message; }
    },
    cancelTfa: function () { this.tfaSecret = ''; this.tfaQr = ''; this.tfaCode = ''; },
    enableTfa: async function () {
      this.tfaBusy = true;
      try {
        var j = await this.sessPost('/api/two-factor/enable', { code: this.tfaCode, signOutOthers: this.tfaSignOutOthers });
        this.twoFactor = j.twoFactor; this.sessionRows = j.sessions;
        this.cancelTfa();
        this.showToast('✓ two-factor sign-in is on', true, 5000);
      } catch (e) { this.sessionError = e.message; } finally { this.tfaBusy = false; }
    },
  };
});
`;
