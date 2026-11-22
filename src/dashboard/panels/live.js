// Panel: live updates. GET /api/stream is a server-sent event stream. One loop per dashboard
// builds the /api/tunnels payload every few seconds (only while someone is watching), and
// sends `changed` when it differs from the last one (the page then reloads it) and `tick`
// otherwise (the page just moves its clock). Dashboard actions (events) trigger a check
// right away. Streams end after a few minutes so the session cookie is checked again on
// reconnect. The page falls back to polling every 5 s when the stream is unavailable.
// BURROW_DASHBOARD_LIVE=off turns the stream off (the page polls as before).
import { createHash } from 'node:crypto';

export const order = 5;
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
const INTERVAL_MS = () => num(process.env.BURROW_LIVE_MS, 3000);
const MAX_CLIENTS = () => num(process.env.BURROW_LIVE_MAX_CLIENTS, 20);
const MAX_AGE_MS = () => num(process.env.BURROW_LIVE_MAX_AGE_MS, 5 * 60 * 1000);

// Hash of the payload minus fields that change on every read.
export function payloadHash(data) {
  const { now, ...rest } = data || {};
  return createHash('sha1').update(JSON.stringify(rest)).digest('hex');
}

const hubs = new WeakMap(); // http.Server -> hub (one per dashboard)
function hubFor(ctx) {
  const server = ctx.req.socket.server;
  let hub = hubs.get(server);
  if (hub) return hub;
  hub = { clients: new Set(), timer: null, running: false, hash: null, again: false, ctx: null, onEvent: null };
  const send = (c, event, data) => { try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };
  hub.check = async () => {
    if (!hub.clients.size) return;
    if (hub.running) { hub.again = true; return; }
    hub.running = true;
    try {
      const data = await hub.ctx.snapshot();
      const h = payloadHash(data);
      const event = hub.hash !== null && h !== hub.hash ? 'changed' : 'tick';
      hub.hash = h;
      for (const c of hub.clients) send(c, event, { now: data.now });
    } catch (e) {
      hub.ctx.log(`error: live updates: ${e.message}`);
    } finally {
      hub.running = false;
      if (hub.again) { hub.again = false; setTimeout(hub.check, 50); }
    }
  };
  hub.start = () => {
    if (hub.timer) return;
    hub.timer = setInterval(hub.check, INTERVAL_MS());
    hub.timer.unref?.();
    let debounce = null;
    hub.onEvent = () => { clearTimeout(debounce); debounce = setTimeout(hub.check, 300); };
    ctx.events.on('event', hub.onEvent);
  };
  hub.stop = () => {
    clearInterval(hub.timer); hub.timer = null; hub.hash = null;
    if (hub.onEvent) ctx.events.off('event', hub.onEvent);
    hub.onEvent = null;
  };
  hubs.set(server, hub);
  return hub;
}

export async function route(ctx) {
  if (ctx.method !== 'GET' || ctx.path !== '/api/stream') return false;
  if (/^(off|0|false|no)$/i.test(process.env.BURROW_DASHBOARD_LIVE || '')) {
    return ctx.json(404, { error: 'live updates are turned off (BURROW_DASHBOARD_LIVE=off)' }) ?? true;
  }
  const hub = hubFor(ctx);
  if (hub.clients.size >= MAX_CLIENTS()) {
    return ctx.json(503, { error: 'too many live connections; polling instead' }, { 'Retry-After': '30' }) ?? true;
  }
  const { req, res } = ctx;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive',
  });
  res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ now: Date.now(), intervalMs: INTERVAL_MS() })}\n\n`);
  const client = { res };
  hub.ctx = ctx;
  hub.clients.add(client);
  hub.start();
  const end = setTimeout(() => { try { res.end(); } catch {} }, MAX_AGE_MS());
  end.unref?.();
  const gone = () => {
    clearTimeout(end);
    hub.clients.delete(client);
    if (hub.ctx === ctx && hub.clients.size) hub.ctx = [...hub.clients][0].ctx || hub.ctx;
    if (!hub.clients.size) hub.stop();
  };
  client.ctx = ctx;
  req.on('close', gone);
  res.on('close', gone);
  return true;
}

export const html = {
  toolbar: '<li><small class="live-status" :class="liveClass" :title="liveTitle" x-text="liveText"></small></li>',
};

export const css = `
.live-status{display:inline-flex;align-items:center;gap:.3rem;color:var(--pico-muted-color);white-space:nowrap}
.live-status::before{content:"";width:.5rem;height:.5rem;border-radius:50%;background:currentColor}
.live-status.live{color:#1f9d55}.live-status.polling{color:#d97706}
`;

export const js = `
burrowPanel(function () {
  return {
    liveState: 'connecting', liveEs: null, liveFailures: 0, liveRetry: null,
    get liveText() { return this.liveState === 'live' ? 'Live' : this.liveState === 'polling' ? 'Polling' : 'Connecting'; },
    get liveClass() { return this.liveState; },
    get liveTitle() {
      return this.liveState === 'live' ? 'Updates are pushed as they happen'
        : this.liveState === 'polling' ? 'Live updates unavailable: refreshing every 5 seconds' : 'Connecting to live updates';
    },
    init: function () {
      if (typeof EventSource === 'undefined') { this.liveState = 'polling'; return; }
      clearInterval(this.timer); this.timer = null;
      this.liveConnect();
    },
    livePoll: function () {
      var self = this;
      this.liveState = 'polling';
      if (!this.timer) this.timer = setInterval(function () { self.load(); }, 5000);
    },
    liveConnect: function () {
      var self = this;
      clearTimeout(this.liveRetry);
      var es = new EventSource('/api/stream');
      this.liveEs = es;
      es.addEventListener('hello', function () {
        self.liveFailures = 0; self.liveState = 'live';
        clearInterval(self.timer); self.timer = null;
        self.load();
      });
      es.addEventListener('changed', function () { self.load(); });
      es.addEventListener('tick', function (e) {
        try { var d = JSON.parse(e.data); if (d.now) self.now = d.now; } catch (err) {}
      });
      es.onerror = function () {
        es.close();
        if (self.liveEs !== es) return;
        self.liveEs = null;
        self.liveFailures++;
        // A stream that ends normally reconnects quickly; repeated failures poll meanwhile.
        if (self.liveFailures > 1) self.livePoll(); else self.liveState = 'connecting';
        var wait = Math.min(30000, 1000 * Math.pow(2, Math.max(0, self.liveFailures - 1)));
        self.liveRetry = setTimeout(function () { self.liveConnect(); }, wait);
      };
    },
  };
});
`;
