import { createServer } from 'node:http';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.xml': 'application/xml',
};

// Read-only static file server on 127.0.0.1 for "expose a folder". GET/HEAD only, no
// directory listings, no dotfiles, and every path is resolved and checked to stay
// inside the folder (symlinks included).
export function serveFolder(folder, { port = 0 } = {}) {
  const root = realpathSync(folder);
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
    if (rel.includes('\0') || rel.split('/').some((seg) => seg.startsWith('.'))) { res.writeHead(404); res.end('Not found'); return; }
    let file;
    try {
      file = realpathSync(join(root, rel));
      if (file !== root && !file.startsWith(root + sep)) throw new Error('outside');
      if (statSync(file).isDirectory()) {
        file = realpathSync(join(file, 'index.html'));
        if (!file.startsWith(root + sep)) throw new Error('outside');
      }
      if (!statSync(file).isFile()) throw new Error('not a file');
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({ port: server.address().port, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) });
    });
  });
}
