# duck-ai-api — API diye duck.ai model use korar project

Goal (Likhon-er kotha onujayi): **nijer code/app theke API call kore
duck.ai-r model (Luna) use kora.**

```text
Tomar app / code
      |  POST http://localhost:3000/chat  {"message":"hi","model":"Luna"}
      v
Ei API server (Node.js)
      |  browser mode: ekta real browser-e duck.ai khule,
      |  Luna select kore, message pathiye, reply pore ney
      v
duck.ai (Luna / "GPT-6 Luna" — captured session-e dekha model)
      |
      v
Reply JSON akare tomar app-e fire ashe: {"model":"Luna","reply":"..."}
```

## Keno browser mode — token capture diye na keno

duck.ai-r official API key nai. Site-ta proti session-e ephemeral
anti-abuse token use kore, jegulo browser-er baire ber kore reuse kora
stable o na, site-er protection bypass-o. Tai ei project token dhore na.

Tar bodle browser mode page-take manush jibhabe use kore thik sevabe use
kore: page khola -> privacy Continue -> model select -> chat box-e lekha
-> reply pora. Token ja lagar browser nijei nijer bhitore handle kore.

Mathay rekho: personal use-er jonno, kom rate-e use koro; duck.ai-r UI
bodlale `src/browserClient.js`-er selector gulo update lagte pare.

## Chalao — real model use korte

```bash
cd duck-ai-api
npm install playwright
npx playwright install chromium

npm run start:browser
# ba: DUCK_MODE=browser node server.js
```

## API use koro

```bash
curl -X POST http://localhost:3000/chat \
  -H 'content-type: application/json' \
  -d '{"message":"hi","model":"Luna"}'
```

Python / JS theke: `examples/call_from_python.py`, `examples/call_from_js.mjs`

Onno endpoints: `GET /health`, `GET /models`, `GET /capture`

## Mode gulo

| Mode | Mane |
|---|---|
| `browser` | **Real** — duck.ai-r model sotti use kore (upore dekhano) |
| `mock` (default) | Test mode — captured reply replay kore, browser lage na |
| `upstream` | Shudhu tumi nije supply kora header diye direct call (ephemeral, recommended na) |

## Test status (2026-10-20)

- Mock mode: PASS — `/health` ar `/chat {"message":"hi"}` thik reply diyeche
- Browser mode code: install + syntax PASS, kintu ei sandbox VM theke
  end-to-end test kora jay nai — VM-er special egress proxy Playwright-er
  CONNECT tunnel accept kore na (`ERR_TUNNEL_CONNECTION_FAILED`, emonki
  example.com-er jonno-o). Normal machine / server-e (jekhane direct net
  ba standard proxy ache) browser mode cholar kotha.
- Live praman: Muse browser diye duck.ai-te Luna model-e "hi" pathiye
  "Hi! How can I help?" reply pawa geche — capture.json-e ache.

## Files

- `server.js` — API server (`POST /chat`, zero dependency)
- `src/browserClient.js` — browser automation backend (Playwright)
- `src/duckClient.js` — model list + upstream request shape
- `capture.json` — live capture (Luna, "hi" -> "Hi! How can I help?") + research notes
- `examples/` — Python ar JS theke API call korar example
