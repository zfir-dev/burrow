// Panel: quick actions. Per hostname: copy the URL, open it, or show a QR code for
// testing on a phone (qrcode-generator, vendored from node_modules and loaded on first
// use). Per project: Restart (re-sync and restart the connector, like `burrow restart`).
import { assertLabel } from '../../naming.js';
import { DASHBOARD_PROJECT } from '../../project.js';

export const order = 40;

export const vendor = {
  '/vendor/qrcode.js': { pkg: 'qrcode-generator', type: 'text/javascript; charset=utf-8' },
};

export async function route(ctx) {
  const m = ctx.path.match(/^\/api\/tunnels\/([^/]+)\/restart$/);
  if (ctx.method !== 'POST' || !m) return false;
  const project = m[1];
  try { assertLabel(project, 'project'); } catch { return ctx.json(400, { error: 'bad project' }) ?? true; }
  if (project === DASHBOARD_PROJECT) {
    return ctx.json(400, { error: 'Restarting the dashboard tunnel would cut off this page; use "burrow restart burrow" on the server' }) ?? true;
  }
  const r = await ctx.withBusy(project, async () => {
    ctx.log(`restart ${project} (requested from ${ctx.clientIp})`);
    const run = await ctx.runCli(['restart', project]);
    ctx.invalidate();
    return run;
  });
  if (!r) ctx.json(409, { error: `${project} is busy` });
  else ctx.json(r.ok ? 200 : 500, r);
  return true;
}

export const html = {
  hostExtras: `<span class="quick">
<button class="icon" type="button" title="Copy URL" aria-label="Copy URL" @click="copyUrl(h)">⧉</button>
<button class="icon" type="button" title="Open in a new tab" aria-label="Open URL" @click="openUrl(h)">↗</button>
<button class="icon" type="button" title="QR code for your phone" aria-label="Show QR code" @click="showQr(h)">▦</button>
</span>`,
  rowActions: '<button class="secondary outline" :disabled="restartDisabled(p)" :title="restartTitle(p)" :aria-busy="isBusy(p)" @click="restart(p)">Restart</button>',
  dialogs: `
<dialog :open="qrOpen" class="qr-dialog" @click.self="closeQr">
  <article>
    <header><strong>Open on your phone</strong></header>
    <p class="qr-img"><img :src="qrSrc" :alt="qrAlt" width="264" height="264" x-show="hasQr"></p>
    <p class="error" x-show="hasQrError" x-text="qrError"></p>
    <p class="qr-url"><code x-text="qrUrl"></code></p>
    <footer>
      <button class="secondary" @click="closeQr">Close</button>
      <button @click="copyQrUrl">Copy URL</button>
    </footer>
  </article>
</dialog>`,
};

export const css = `
.quick{display:inline-flex;gap:.15rem;opacity:.45}.host:hover .quick,.quick:focus-within{opacity:1}
button.icon{all:unset;cursor:pointer;font-size:.85rem;line-height:1;padding:.1rem .25rem;border-radius:4px;color:var(--pico-muted-color)}
button.icon:hover,button.icon:focus-visible{color:var(--pico-primary);background:var(--pico-secondary-focus)}
.qr-dialog article{width:min(360px,100%);text-align:center}
.qr-img img{image-rendering:pixelated;background:#fff;padding:8px;border-radius:8px}
.qr-url code{word-break:break-all}
`;

export const js = `
burrowPanel(function () {
  var qrLoading = null;
  function loadQrLib() {
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
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  return {
    qrOpen: false, qrUrl: '', qrSrc: '', qrError: '',
    get hasQr() { return this.qrSrc.length > 0; },
    get hasQrError() { return this.qrError.length > 0; },
    get qrAlt() { return 'QR code for ' + this.qrUrl; },

    copyText: async function (text) {
      var ok = false;
      try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; } } catch (e) { ok = false; }
      if (!ok) ok = fallbackCopy(text);
      this.showToast(ok ? '✓ Copied ' + text : 'Copy this URL: ' + text, ok, 4000);
    },
    copyUrl: function (h) { this.copyText(this.hostUrl(h)); },
    copyQrUrl: function () { this.copyText(this.qrUrl); },
    openUrl: function (h) { window.open(this.hostUrl(h), '_blank', 'noopener,noreferrer'); },
    showQr: async function (h) {
      this.qrUrl = this.hostUrl(h); this.qrSrc = ''; this.qrError = ''; this.qrOpen = true;
      try {
        await loadQrLib();
        var q = window.qrcode(0, 'M');
        q.addData(this.qrUrl);
        q.make();
        this.qrSrc = q.createDataURL(6, 2);
      } catch (e) { this.qrError = e.message; }
    },
    closeQr: function () { this.qrOpen = false; },

    restartDisabled: function (p) { return p.builtIn || !p.canUp || this.isBusy(p); },
    restartTitle: function (p) {
      if (p.builtIn) return 'Use "burrow restart burrow" on the server';
      return p.canUp ? 'Re-sync tunnel.yml and restart cloudflared' : 'No remembered tunnel.yml';
    },
    restart: function (p) { this.act(p, 'restart'); },
  };
});
`;
