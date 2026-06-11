// Shared logic for both the local server (server.js) and the Vercel function
// (api/proxy.js, api/render.js): rewrite fetched/rendered HTML so it frames and
// carries the bridge, and call a hosted headless browser for cloud-render mode.

// Prepare a page's HTML for the tester iframe: strip CSP, inject <base> + bridge,
// and (for cloud-rendered snapshots) neutralize the page's own scripts so the
// already-rendered DOM displays statically without re-hydrating or re-fetching.
function transformHtml(html, finalUrl, bridgeSrc, opts = {}) {
  // Strip CSP <meta> tags so the injected bridge script and bundle eval work.
  html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');

  if (opts.stripScripts) {
    // The headless browser already ran the page's JS, so the DOM is complete.
    // Removing the scripts gives a stable static snapshot: no SPA re-hydration
    // crashes (origin allowlists), no CORS re-fetches. The bridge is injected
    // afterwards, so it survives.
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script\b[^>]*\/>/gi, '');
  }

  const injection = [];
  // <base> so relative URLs (css/img) resolve against the real origin.
  if (!/<base\s/i.test(html)) {
    injection.push(`<base href="${String(finalUrl).replace(/"/g, '&quot;')}" data-codi-bridge="1">`);
  }
  // Bridge must be inlined: the <base> above would make a src="/bridge.js"
  // resolve against the target site's origin, not ours.
  injection.push(`<script data-codi-bridge="1">${bridgeSrc.replace(/<\/script/gi, '<\\/script')}</script>`);
  const inject = injection.join('\n');

  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => m + '\n' + inject);
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html[^>]*>/i, (m) => m + '\n' + inject);
  } else {
    html = inject + '\n' + html;
  }
  return html;
}

// Call a hosted headless browser to render a URL at its real origin and return
// the fully-rendered HTML. Provider-agnostic via env vars; defaults to the
// Browserless `/content` contract (POST { url }, returns text/html).
//   RENDER_API_URL   e.g. https://production-sfo.browserless.io/content
//   RENDER_API_TOKEN appended as ?token=… (optional if baked into the URL)
async function fetchRendered(targetUrl, env) {
  const base = env.RENDER_API_URL;
  if (!base) {
    const err = new Error(
      'Cloud render is not configured. Set RENDER_API_URL (and RENDER_API_TOKEN) ' +
      'to a headless-browser endpoint such as Browserless /content.'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const token = env.RENDER_API_TOKEN;
  const endpoint = token
    ? base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
    : base;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: targetUrl,
      gotoOptions: { waitUntil: 'networkidle2', timeout: 30000 },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Render API returned ${res.status}: ${text.slice(0, 300)}`);
    err.code = 'RENDER_FAILED';
    throw err;
  }
  return res.text();
}

module.exports = { transformHtml, fetchRendered };
