// Vercel serverless function — the deployed equivalent of server.js's /proxy.
// Fetches a target site, strips frame-blocking CSP, injects the bridge inline.
// Exposed at /proxy via the rewrite in vercel.json.

const { transformHtml } = require('../lib/transform');

// Fetch our own bridge.js (forwarding basic-auth so the middleware allows it).
async function getBridge(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const r = await fetch(`${proto}://${req.headers.host}/bridge.js`, {
    headers: req.headers.authorization ? { authorization: req.headers.authorization } : {},
  });
  return r.text();
}

module.exports = async (req, res) => {
  let target = req.query.url;
  if (!target) return res.status(400).send('Missing ?url= parameter');
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  // Forward method + body so the bridge's rerouted API calls (POST/GraphQL
  // etc.) work, not just page loads. Vercel pre-parses bodies, so re-serialize.
  const method = req.method || 'GET';
  let body;
  if (method !== 'GET' && method !== 'HEAD' && req.body != null) {
    body = Buffer.isBuffer(req.body) || typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }

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
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(502).send(`Proxy fetch failed for ${target}\n\n${err.message}`);
  }

  const finalUrl = upstream.url || target;
  const contentType = upstream.headers.get('content-type') || '';

  // Non-HTML resources: pass through untouched.
  if (!contentType.includes('text/html')) {
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    return res.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
  }

  const raw = await upstream.text();
  const html = transformHtml(raw, finalUrl, await getBridge(req));

  // Deliberately omit X-Frame-Options / CSP headers so the page frames.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Proxied-From', finalUrl);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(upstream.status).send(html);
};
