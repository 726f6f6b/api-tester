# Codi API Tester

A local dashboard for testing the Codi partner WebSocket API (`wss://api.codi-agent.com/partner/intent/agent`) against real websites — no manual console copy-pasting.

## Run it

```sh
node server.js
# open http://localhost:4000
```

No dependencies. Node 18+ required (uses built-in `fetch`).

## Workflow

The UI guides you: the next step's button is highlighted (black) and steps are disabled until their prerequisites are met — API key → load page → prompt → send → apply.

1. **Paste your API key** in the top bar (saved in your browser's localStorage — it is not stored in any file).
2. **Load a real site** with the URL bar on the right. The local server proxies it (stripping `X-Frame-Options`/CSP so it can render in the iframe) and injects a bridge script for HTML capture and code injection.
3. **Write a prompt** and hit **Send**. The tester grabs the page's live HTML automatically, connects the WebSocket if needed, and sends `{type:"call", rpc:"run", payload:{prompt, html}}`.
4. Watch the stream in the log: `messages/partial` (live-updating), `messages/complete`, `values`, errors.
5. The generated code lands in the **Bundle** box → **⚡ Apply to page** runs it inside the loaded page so you see the change live. **Reset page** reloads the iframe to undo.
6. **Follow-ups**: just type another prompt and Send — the `rpcId` auto-increments and the same `thread_id` is reused so the agent keeps context. **↻ new** starts a fresh thread.

## Targeted-changes mode

Click **🎯 Pick from page**, then click any element in the loaded site. Its `outerHTML` is captured into the *Selected element* box and sent as `selectedElementHTML`, switching the API to targeted mode. **Esc** cancels picking.

## Health & metrics

- **Health check** button: opens a throwaway connection and reports whether the API is up and your key is accepted, with handshake latency. Close codes are surfaced (auth failures usually show as abnormal close codes).
- Header chips track per-request metrics: **connect** (WS handshake), **first event** (send → first streamed frame), **bundle** (send → final code), message count, and error count.
- The captured page HTML size shows next to the URL bar once a page loads, and per-request sizes appear in the log.

## Session report

The **Report** button (top right) downloads a Markdown file with everything from the session for later analysis: summary stats (success rate, average first-event and bundle latencies), health-check results, a per-request table (prompt, mode, HTML size, timings, bundle size, outcome), every bundle in full, the event log, and the raw session JSON in a fenced block at the end.

## Files

- `server.js` — static server + `/proxy?url=…` (fetches the target page, strips frame-blocking headers/meta CSP, injects a `<base>` tag and the bridge inline).
- `public/index.html` — the dashboard UI and WebSocket client.
- `public/bridge.js` — injected into proxied pages; handles HTML capture, the element picker, bundle execution, and error reporting back to the dashboard via `postMessage`.

## Deploying (Vercel)

The Vercel layout mirrors the local server: the UI in `public/` is served as static files ([vercel.json](vercel.json) sets it as the output directory), `/proxy` runs as a serverless function ([api/proxy.js](api/proxy.js), rewritten from `/proxy`), and [middleware.js](middleware.js) gates everything behind basic auth. The Codi WebSocket goes browser → Codi directly, so no server-side WS is needed.

Either connect the GitHub repo in the Vercel dashboard (deploy-on-push), or from the CLI:

```sh
npx vercel login    # once
npx vercel          # preview deploy + link project
npm run deploy      # = vercel --prod
```

**Set the `TESTER_PASSWORD` environment variable in Vercel project settings on any public deployment.** It puts the whole app behind HTTP basic auth (username `codi`, password = the value you set). Without it, `/proxy` is an open proxy anyone could abuse. Codi API keys are never stored server-side — each user pastes their own key, which lives only in their browser's localStorage.

The plain Node server ([server.js](server.js)) is for local use (`npm start`) and also deploys anywhere Node 18+ runs (Render, Railway, a VPS): port from `PORT`, same `TESTER_PASSWORD` env var.

## Cloud render mode (fallback for stubborn sites)

Some sites won't load fully through the proxy — single-page apps with hardcoded **origin allowlists** (e.g. an embedded CMS live-preview SDK), or product data behind **cookie/CORS-gated APIs**. These fail because the proxied request comes from the tester's origin, not the site's own.

The **Cloud render** toggle (next to the URL bar) fixes this: a hosted headless browser loads the URL at the site's *real* origin — so origin checks pass and same-origin APIs resolve — and the tester serves that fully-rendered snapshot (with the page's own scripts stripped so it stays stable). Codi's bundle still applies on top, since bundles are CSS/DOM changes.

It's opt-in per load, so use Proxy by default and flip to Cloud render only when a page looks incomplete.

**Configure a headless backend** via env vars (Vercel project settings, or your shell for local `npm start`):

```
RENDER_API_URL=https://production-sfo.browserless.io/content
RENDER_API_TOKEN=<your token>
```

It targets the [Browserless](https://browserless.io) `/content` contract (`POST { url }` → rendered HTML) by default; any endpoint with that shape works, including a self-hosted Browserless Docker container. Without these set, Cloud render returns a clear "not configured" message and Proxy mode is unaffected.

## Caveats

- Sites are proxied with a `<base>` tag so their assets load from the real origin — most sites render fine, but heavy SPAs that fetch same-origin APIs may partially break (their XHRs go to the real origin and can hit CORS). The HTML capture and bundle injection still work.
- Bundles are executed with `eval` inside the proxied page — same effect as pasting in the console, as the API docs intend.
