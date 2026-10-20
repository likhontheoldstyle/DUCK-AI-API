# duck-ai-api — scrape kore duck.ai model use korar API

> Correction (Likhon): browser automation diye na, **scrape kore** banano.
> v0.3 theke default backend-i scrape. Browser automation fallback hishebe
> code-e ache, kintu main rasta eta na.

## Jibhabe kaj kore — 3 phase scrape

```text
Tomar code --POST /chat {"message":"hi","model":"Luna"}--> ei server
  Phase 1: GET https://duck.ai/
           HTML theke scrape: <html data-version-tag data-version-sha>
           -> x-fe-version = "<tag>-<sha>"
  Phase 2: GET https://duckduckgo.com/duckchat/v1/status  (x-vqd-accept: 1)
           response header x-vqd-hash-1 = base64 JS challenge
           -> JSDOM sandbox-e run kore hash header banano
  Phase 3: POST https://duckduckgo.com/duckchat/v1/chat (SSE)
           headers: x-fe-version, x-vqd-hash-1
           body: {model: "gpt-5.6-luna", messages: [...]}
<-- JSON reply {"model":"gpt-5.6-luna","reply":"...","mode":"scrape"}
```

## Live scrape result (2026-10-20, capture.json-e full ache)

- Phase 1: ✅ `data-version-tag="serp_20261019_215825_ET"`, `data-version-sha="bb9ccdb8..."`
- Model ID (bundle theke scrape): Luna = **`gpt-5.6-luna`**, aro ache `gpt-5.6-terra`, `claude-sonnet-4-6`, `gpt-5.4`...
- Phase 2: ✅ challenge JS JSDOM-e run hoy, `server_hashes`/`client_hashes`/`meta` return kore
- Phase 3: request shape ekhon full reverse-engineer kora — chat URL
  `duck.ai/duckchat/v1/chat`, solver-er SHA-256 transform, `x-fe-signals`,
  `x-ddg-journey-id`, body-te content-parts array. Code-e shob boshano.
  Kintu ei sandbox VM theke live chat test sombhob na: VM-er egress proxy
  POST-i atke dey (control test: example.com-e POST-o timeout, GET thik ache).
  **Normal network-e (tomar machine/server) chaliye dekhte hobe** — sekhane
  POST pouchabe. VM theke jachai kora shesh sima Phase 2 porjonto.

Diagnostics nije chalaite: `GET /scrape-status` (Phase 1+2 live run kore dekhay)

## Chalao

```bash
cd duck-ai-api
npm install
npm start            # default mode: scrape
curl -X POST http://localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"hi","model":"Luna"}'
```

## Mode

| Mode | Mane |
|---|---|
| `scrape` (default) | Direct HTTP scrape — uporer 3 phase |
| `mock` | Test — captured reply replay |
| `browser` | Purono fallback — Playwright diye page automation (heavy, recommended na) |
| `upstream` | Nijer supply kora header diye direct call |

## Files

- `server.js` — API server
- `src/scrapeClient.js` — **scrape backend (main)**
- `src/browserClient.js` — purono browser fallback
- `src/duckClient.js` — model list + upstream shape
- `capture.json` — live capture + scrape research, sources shoho
- `examples/` — Python / JS theke call korar example
