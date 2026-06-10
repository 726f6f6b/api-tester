// Codi API Tester — local server
// Serves the tester UI and proxies arbitrary websites so they can be
// loaded in an iframe (strips X-Frame-Options / CSP) with a bridge
// script injected for HTML capture, element picking and bundle injection.
//
// Usage: node server.js   (then open http://localhost:4000)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleProxy(req, res, query) {
  let target = query.get('url');
  if (!target) return send(res, 400, 'Missing ?url= parameter');
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  // Forward method + body so the bridge's rerouted API calls (POST/GraphQL
  // etc.) work, not just page loads.
  const method = req.method || 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);

  let upstream;
  try {
    upstream = await fetch(target, {
      redirect: 'follow',
      method,
      body,
      headers: {
        'User-Agent':
          req.headers['user-agent'] ||
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
      },
    });
  } catch (err) {
    return send(res, 502, `Proxy fetch failed for ${target}\n\n${err.message}`, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
  }

  const finalUrl = upstream.url || target;
  const contentType = upstream.headers.get('content-type') || '';

  // Non-HTML resources: stream through untouched (rarely hit, since the
  // injected <base> tag makes subresources load from the real origin).
  if (!contentType.includes('text/html')) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    return send(res, upstream.status, buf, { 'Content-Type': contentType || 'application/octet-stream' });
  }

  let html = await upstream.text();

  // Strip CSP <meta> tags so our injected bridge script and bundle eval work.
  html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');

  const injection = [];
  // <base> so relative URLs (css/js/img) resolve against the real origin.
  if (!/<base\s/i.test(html)) {
    injection.push(`<base href="${finalUrl.replace(/"/g, '&quot;')}" data-codi-bridge="1">`);
  }
  // Bridge must be inlined: the <base> tag above would make a src="/bridge.js"
  // reference resolve against the target site's origin, not this server.
  const bridgeSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'bridge.js'), 'utf8');
  injection.push(`<script data-codi-bridge="1">${bridgeSrc.replace(/<\/script/gi, '<\\/script')}</script>`);
  const inject = injection.join('\n');

  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => m + '\n' + inject);
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html[^>]*>/i, (m) => m + '\n' + inject);
  } else {
    html = inject + '\n' + html;
  }

  // Deliberately omit X-Frame-Options / CSP headers so the page frames.
  send(res, upstream.status, html, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Proxied-From': finalUrl,
    'Cache-Control': 'no-store',
  });
}

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found: ' + pathname);
    send(res, 200, data, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
  });
}

// When TESTER_PASSWORD is set (recommended for any public deployment), the
// whole app — including the open /proxy route — sits behind HTTP basic auth.
const PASSWORD = process.env.TESTER_PASSWORD || null;
function authorized(req) {
  if (!PASSWORD) return true;
  const expected = 'Basic ' + Buffer.from('codi:' + PASSWORD).toString('base64');
  return req.headers.authorization === expected;
}

const server = http.createServer((req, res) => {
  if (!authorized(req)) {
    return send(res, 401, 'Authentication required', { 'WWW-Authenticate': 'Basic realm="Codi API Tester"' });
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/proxy') return handleProxy(req, res, url.searchParams);
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`\n  Codi API Tester running:  http://localhost:${PORT}\n`);
});
