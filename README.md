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

## Deploying (Cloudflare Workers)

[worker.js](worker.js) + [wrangler.jsonc](wrangler.jsonc) mirror the local server for Cloudflare: the UI is served as static assets and `/proxy` runs in the Worker. The Codi WebSocket goes browser → Codi directly, so no server-side WS is needed.

```sh
npx wrangler login                          # once
npx wrangler secret put TESTER_PASSWORD     # gate the app (recommended)
npm run deploy                              # = wrangler deploy
```

You get a `https://codi-api-tester.<account>.workers.dev` URL. Local Worker dev: `npm run dev:cf`.

**Set the `TESTER_PASSWORD` secret on any public deployment.** It puts the whole app behind HTTP basic auth (username `codi`, password = the value you set). Without it, `/proxy` is an open proxy anyone could abuse. Codi API keys are never stored server-side — each user pastes their own key, which lives only in their browser's localStorage.

The plain Node server ([server.js](server.js)) also deploys anywhere Node 18+ runs (Render, Railway, a VPS): `npm start`, port from `PORT`, same `TESTER_PASSWORD` env var.

## Caveats

- Sites are proxied with a `<base>` tag so their assets load from the real origin — most sites render fine, but heavy SPAs that fetch same-origin APIs may partially break (their XHRs go to the real origin and can hit CORS). The HTML capture and bundle injection still work.
- Bundles are executed with `eval` inside the proxied page — same effect as pasting in the console, as the API docs intend.
