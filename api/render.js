// Vercel serverless function — cloud-render mode (the deployed equivalent of
// server.js's /render). A hosted headless browser loads the URL at its real
// origin (sidestepping origin allowlists / CORS / cookie walls), then we serve
// that fully-rendered snapshot — scripts stripped — into the iframe.
// Exposed at /render via the rewrite in vercel.json.

const { transformHtml, fetchRendered, looksLikeChallenge } = require('../lib/transform');

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

  let rendered;
  try {
    rendered = await fetchRendered(target, process.env);
  } catch (err) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(err.code === 'NOT_CONFIGURED' ? 501 : 502).send(err.message);
  }

  const html = transformHtml(rendered, target, await getBridge(req), { stripScripts: true });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Rendered-From', target);
  res.setHeader('X-Render-Challenge', looksLikeChallenge(rendered) ? '1' : '0');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(html);
};
