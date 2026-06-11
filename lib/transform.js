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
//                    or   …/unblock  to defeat bot-detection / captchas
//   RENDER_API_TOKEN appended as ?token=… (optional if baked into the URL)
//   RENDER_API_OPTS  optional JSON merged into the request body (proxy, waitFor,
//                    blockAds, etc.) — lets you tune the provider without edits
//
// Two endpoint shapes are handled:
//  - …/unblock : a "web unblocker" that solves challenges; body { url, content:true },
//    response JSON { content }. Use this for anti-bot sites (Boots, etc.).
//  - anything else (e.g. /content): body { url, … }, response is the HTML directly.
async function fetchRendered(targetUrl, env) {
  const base = env.RENDER_API_URL;
  if (!base) {
    const err = new Error(
      'Cloud render is not configured. Set RENDER_API_URL (and RENDER_API_TOKEN) ' +
      'to a headless-browser endpoint such as Browserless /content (or /unblock for anti-bot sites).'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const token = env.RENDER_API_TOKEN;
  let extra = {};
  if (env.RENDER_API_OPTS) {
    try { extra = JSON.parse(env.RENDER_API_OPTS); } catch (e) { /* ignore bad JSON */ }
  }

  const withToken = (b) => token ? b + (b.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : b;

  async function call(b) {
    const isUnblock = /\/unblock(\b|\?|$)/.test(b);
    const body = isUnblock
      ? { url: targetUrl, content: true, ...extra }
      : { url: targetUrl, gotoOptions: { waitUntil: 'networkidle2', timeout: 30000 }, ...extra };
    const res = await fetch(withToken(b), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Render API returned ${res.status}: ${text.slice(0, 300)}`);
      err.code = 'RENDER_FAILED';
      throw err;
    }
    if (isUnblock) {
      const json = await res.json().catch(() => ({}));
      return json.content || json.html || '';
    }
    return res.text();
  }

  let html = await call(base);
  // Auto-escalate to a /unblock endpoint if a /content render hit a bot
  // challenge — so the single toggle handles both normal and anti-bot sites.
  if (looksLikeChallenge(html) && /\/content(\b|\?|$)/.test(base)) {
    try {
      const unblocked = await call(base.replace('/content', '/unblock'));
      if (unblocked && !looksLikeChallenge(unblocked)) html = unblocked;
    } catch (e) { /* keep the original result */ }
  }
  return html;
}

// Heuristic: did a rendered page come back as a bot wall / captcha rather than
// the real content? Drives auto-escalation to /unblock and the UI warning.
// Covers the common WAFs: Cloudflare, hCaptcha/reCAPTCHA, Imperva/Incapsula,
// Distil, PerimeterX.
function looksLikeChallenge(html) {
  if (!html) return false;
  if (/hcaptcha\.com\/|recaptcha\/api|__cf_chl|cf-challenge|challenge-platform/i.test(html)) return true;
  if (/_Incapsula_Resource|Incapsula incident|distil_referrer|Request unsuccessful|px-captcha|_pxhd/i.test(html)) return true;
  if (html.length < 3000 && /captcha|are you human|security check|just a moment|unusual traffic|bot detection/i.test(html)) return true;
  return false;
}

// Server-side CSS inlining: fetch each <link rel=stylesheet> and replace it with
// a <style> holding the rules. Unlike the client-side inliner this has no
// cross-origin limits, so it makes proxy/cloud captures carry complete CSS.
// Resolves @import recursively and rewrites relative url()/@import to absolute.
async function fetchCss(url, depth, seen) {
  if (depth > 4 || seen.has(url)) return '';
  seen.add(url);
  let css;
  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return '';
    css = await r.text();
  } catch (e) { return ''; }

  const imports = [];
  css = css.replace(/@import\s+(?:url\(\s*)?['"]?([^'")]+)['"]?\s*\)?\s*([^;]*);/gi, (m, href, media) => {
    let abs; try { abs = new URL(href, url).href; } catch (e) { return m; }
    const ph = `/*__codi_import_${imports.length}__*/`;
    imports.push({ abs, media: (media || '').trim(), ph });
    return ph;
  });
  // rewrite relative url(...) against this sheet's own URL
  css = css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi, (m, u) => {
    if (/^(data:|https?:|\/\/|#)/i.test(u)) return m;
    try { return 'url("' + new URL(u, url).href + '")'; } catch (e) { return m; }
  });
  for (const imp of imports) {
    const inner = await fetchCss(imp.abs, depth + 1, seen);
    css = css.replace(imp.ph, imp.media ? `@media ${imp.media}{${inner}}` : inner);
  }
  return css;
}

async function inlineStylesheets(html, baseUrl) {
  const tasks = [];
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*['"]?stylesheet/i.test(tag)) return tag;
    const hrefM = tag.match(/\bhref\s*=\s*['"]([^'"]+)['"]/i);
    if (!hrefM) return tag;
    let abs; try { abs = new URL(hrefM[1], baseUrl).href; } catch (e) { return tag; }
    const media = (tag.match(/\bmedia\s*=\s*['"]([^'"]+)['"]/i) || [])[1];
    const ph = `<!--__codi_css_${tasks.length}__-->`;
    tasks.push({ abs, media, ph });
    return ph;
  });
  const seen = new Set();
  await Promise.all(tasks.map(async (t) => {
    let css = await fetchCss(t.abs, 0, seen);
    if (css) {
      css = css.replace(/<\/style/gi, '<\\/style');
      const body = t.media ? `@media ${t.media}{${css}}` : css;
      t.out = `<style data-codi-inlined="${t.abs.replace(/"/g, '&quot;')}">${body}</style>`;
    } else {
      t.out = `<link rel="stylesheet" href="${t.abs.replace(/"/g, '&quot;')}">`; // fallback: absolute link
    }
  }));
  for (const t of tasks) html = html.replace(t.ph, () => t.out);
  return html;
}

module.exports = { transformHtml, fetchRendered, looksLikeChallenge, inlineStylesheets };
