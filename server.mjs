#!/usr/bin/env node
// Zero-dependency dev server.
// Sets COOP/COEP so SharedArrayBuffer is available (lock-free param + MIDI + meter
// transport between the main thread and the audio render thread).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname);
const PORT = Number(process.env.PORT || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';

    // Contain the path inside ROOT.
    const target = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (!target.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }

    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      // crossOriginIsolated => SharedArrayBuffer. `credentialless` keeps
      // no-cors subresources (e.g. webfonts) loadable without CORP headers.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      // Dev: never cache, so a reload always picks up edits.
      'Cache-Control': 'no-store, must-revalidate',
    }).end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(err));
  }
});

server.listen(PORT, () => {
  console.log(`\n  VOX MACHINA  ->  http://localhost:${PORT}\n`);
  console.log('  Cross-origin isolated (SharedArrayBuffer enabled).');
  console.log('  Use headphones. Ctrl-C to stop.\n');
});
