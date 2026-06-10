// Cloudflare Worker entry — the deployed equivalent of server.js.
// Static UI is served from ./public via the assets binding; /proxy fetches a
// target site, strips frame-blocking CSP, and injects the bridge inline.
// Set the TESTER_PASSWORD secret to gate everything behind basic auth.

async function handleProxy(request, env) {
  const reqUrl = new URL(request.url);
  let target = reqUrl.searchParams.get('url');
  if (!target) return new Response('Missing ?url= parameter', { status: 400 });
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  let upstream;
  try {
    upstream = await fetch(target, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          request.headers.get('user-agent') ||
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } catch (err) {
    return new Response(`Proxy fetch failed for ${target}\n\n${err.message}`, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const finalUrl = upstream.url || target;
  const contentType = upstream.headers.get('content-type') || '';

  // Non-HTML resources: stream through untouched.
  if (!contentType.includes('text/html')) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': contentType || 'application/octet-stream' },
    });
  }

  let html = await upstream.text();

  // Strip CSP <meta> tags so the injected bridge script and bundle eval work.
  html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');

  const injection = [];
  // <base> so relative URLs (css/js/img) resolve against the real origin.
  if (!/<base\s/i.test(html)) {
    injection.push(`<base href="${finalUrl.replace(/"/g, '&quot;')}" data-codi-bridge="1">`);
  }
  // Bridge must be inlined: the <base> tag above would make a src="/bridge.js"
  // reference resolve against the target site's origin, not this worker.
  const bridgeRes = await env.ASSETS.fetch(new URL('/bridge.js', request.url));
  const bridgeSrc = await bridgeRes.text();
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
  return new Response(html, {
    status: upstream.status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Proxied-From': finalUrl,
      'Cache-Control': 'no-store',
    },
  });
}

export default {
  async fetch(request, env) {
    if (env.TESTER_PASSWORD) {
      const expected = 'Basic ' + btoa('codi:' + env.TESTER_PASSWORD);
      if (request.headers.get('authorization') !== expected) {
        return new Response('Authentication required', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="Codi API Tester"' },
        });
      }
    }
    const url = new URL(request.url);
    if (url.pathname === '/proxy') return handleProxy(request, env);
    return env.ASSETS.fetch(request);
  },
};
