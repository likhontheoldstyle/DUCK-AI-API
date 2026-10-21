# DUCK-AI-API

A local API server that gives you programmatic access to the AI models on
[duck.ai](https://duck.ai) (DuckDuckGo AI Chat) — text chat, image generation,
and image editing — with **no API key and no account required**.

It talks to duck.ai's backend the same way the official web frontend does:
it scrapes the current frontend version, solves the request challenge
automatically, and streams the response back to you as clean JSON.

Base URL (default): `http://localhost:3000`

---

## Features

- **6 free chat models** — GPT-6 Luna, GPT-5.4 mini, Claude Haiku, Mistral
  Small, Gemma 4, and gpt-oss 120B
- **Image generation** — powered behind the scenes by OpenAI's gpt-image model
- **Image editing** — upload a photo and describe the edit
- **Three API styles**
  - Simple GET endpoints you can paste into a browser
  - Plain POST JSON endpoints
  - A full **OpenAI-compatible** API (`/v1/chat/completions`, streaming included),
    so existing OpenAI SDKs and tools work by just changing the base URL
- **Fully automatic request flow** — frontend version scraping and challenge
  solving are handled internally; there are no tokens or cookies to manage
- **Built-in resilience** — automatic retries, a serial request queue,
  rate-limit waiting, and a short response cache
- **Web test pages** — a chat page, an image viewer page, and an image edit
  page, all served by the server itself

---

## Quick start

```bash
git clone https://github.com/likhontheoldstyle/DUCK-AI-API.git
cd DUCK-AI-API
npm install
npm start
```

Then open <http://localhost:3000> in a browser for the test page, or call the
API from anywhere:

```bash
curl "http://localhost:3000/chat?message=Hello&model=Luna"
```

Works on Windows, Linux, macOS, and Android (Termux).

---

## Models

| Name (use this in requests) | Model ID          | Provider  | Notes                                  |
| ----------------------------- | ----------------- | --------- | -------------------------------------- |
| `Luna`                        | `gpt-6-luna`      | OpenAI    | Default. Best all-rounder, reasoning   |
| `GPT-5.4 mini`                | `gpt-5.4-mini`    | OpenAI    | Small and fast                         |
| `Claude Haiku`                | `claude-haiku-4-5`| Anthropic | Fast Claude, natural writing           |
| `Mistral`                     | `mistral-small-2603` | Mistral AI | General chat, low moderation        |
| `Gemma`                       | `tinfoil/gemma4-31b` | Google  | Privacy-focused (encrypted via Tinfoil) |
| `gpt-oss`                     | `tinfoil/gpt-oss-120b` | OpenAI (open weights) | Encrypted reasoning model |
| `Terra`                       | `gpt-5.6-terra`   | OpenAI    | **Paid** — needs a DuckDuckGo subscription |
| `Claude Sonnet`               | `claude-sonnet-4-6` | Anthropic | **Paid** — needs a DuckDuckGo subscription |

You can pass either the friendly name (`"Luna"`) or the raw model ID
(`"gpt-6-luna"`).

Paid models return a clear `MODEL_RESTRICTED` error on free (anonymous)
access.

### About image generation and editing

Image generation is **not** done by the chat models themselves. The chat
model rewrites your prompt into a detailed one, then delegates the actual
rendering to a dedicated image model (OpenAI's gpt-image, served through
DuckDuckGo). The API response includes the model's `title` and the
`revised_prompt` it used.

---

## Endpoints

### Web pages (open in a browser)

| Page | What it does |
| ---- | ------------ |
| `GET /` | Chat test page with a model selector and an image-generation toggle |
| `GET /image-view?prompt=...` | Generates an image and shows it on a page (with title and revised prompt) |
| `GET /edit` | Image **edit** page — pick a photo, describe the edit, get the edited image |
| `GET /last-image` | Serves the most recently generated/edited image as a raw JPEG |

### Simple GET API (browser-friendly)

```
GET /chat?message=Hello&model=Luna
GET /image?prompt=a+cat+astronaut+in+space&model=Luna
```

`/chat` also accepts `msg` or `q` instead of `message`.

Response:

```json
{
  "model": "gpt-6-luna",
  "reply": "Hello! How can I help?",
  "mode": "scrape",
  "variant": "v2-meta+reasoning"
}
```

### POST API

**Chat**

```http
POST /chat
Content-Type: application/json

{ "message": "Write a haiku about Dhaka", "model": "Claude Haiku" }
```

Multi-turn conversations are supported with a `messages` array
(`[{ "role": "user", "content": "..." }, ...]`).

**Image generation**

```http
POST /image
Content-Type: application/json

{ "prompt": "a cat astronaut in space", "model": "Luna" }
```

Response includes `images` (an array of `data:image/jpeg;base64,...` URLs),
`title`, and `revised_prompt`.

**Image editing**

```http
POST /image-edit
Content-Type: application/json

{
  "image": "data:image/png;base64,....",
  "prompt": "make it a cartoon style",
  "model": "Luna"
}
```

- `image` — a base64 string or a full data URI of the source photo
  (PNG or WebP recommended; large photos are best downscaled to about
  1024 px on the longest side, like the official frontend does)
- `prompt` — the edit instruction
- Response shape is the same as `/image`

### OpenAI-compatible API

Point any OpenAI client at this server — any API key value is accepted:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="duck")

reply = client.chat.completions.create(
    model="Luna",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(reply.choices[0].message.content)
```

| Endpoint | Notes |
| -------- | ----- |
| `POST /v1/chat/completions` | Chat; set `"stream": true` for SSE streaming. Send a top-level `"image": true` field to generate an image instead of text |
| `GET /v1/models` | Lists all models |
| `POST /v1/images/generations` | Image generation; returns OpenAI-style `b64_json` |

### Utility endpoints

| Endpoint | What it does |
| -------- | ------------ |
| `GET /health` | Server status, mode, and model list |
| `GET /models` | Friendly name → model ID map |
| `GET /scrape-status` | Diagnostics: transport, device profile, user agent, and live checks of the version scrape and challenge steps |
| `GET /debug-last` | The raw stream of the most recent chat/image request (for debugging empty replies) |
| `GET /capture` | The built-in capture record |

---

## Configuration (environment variables)

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PORT` | `3000` | Port the server listens on |
| `DUCK_MODE` | `scrape` | `scrape` (real duck.ai backend), `mock` (offline test replies), `browser`, or `upstream` |
| `DUCK_MODEL` | `Luna` | Default model when a request doesn't specify one |
| `DUCK_RETRIES` | `2` | Retries per request variant on challenge rejection |
| `DUCK_MIN_INTERVAL_MS` | `3000` | Minimum gap between upstream requests (requests are queued serially) |
| `DUCK_CACHE_TTL_MS` | `600000` | How long identical requests are served from cache (10 min) |
| `DUCK_429_WAIT_MS` | `60000` | On a rate limit, wait this long and retry once automatically |
| `DUCK_UA` | auto | Override the user agent / device profile (an Android profile is used automatically on Termux) |

Example:

```bash
PORT=8080 DUCK_MODEL="Claude Haiku" npm start
```

---

## How it works

Every chat or image request runs the same three-phase flow the official
duck.ai frontend uses:

1. **Version scrape** — `GET https://duck.ai/` and read the current frontend
   version tag and SHA from the page. These rotate often, so they are
   scraped fresh and cached only briefly.
2. **Challenge** — `GET https://duck.ai/duckchat/v1/status` returns a
   JavaScript anti-bot challenge. The server executes it in a sandbox and
   computes the required SHA-256 based proof header.
3. **Chat** — `POST https://duck.ai/duckchat/v1/chat` with the solved
   headers and a body built exactly like the frontend's (text part first,
   then any image part). The response is an SSE stream, which the server
   parses into text, tool calls, and — for image requests — the generated
   image parts.

For image uploads, the request mirrors the frontend precisely: the user
message content is `[{ type: "text" }, { type: "image", mimeType, image }]`
with the image as a data URL.

Errors are handled automatically where possible: challenge rejections are
retried with fresh proofs and alternate body shapes, and rate limits
trigger one patient wait-and-retry.

---

## Limits and notes

- **Anonymous quota**: duck.ai rate-limits free access per IP address
  (`429 ERR_RATE_LIMIT`). The server queues requests, spaces them out, and
  caches repeats, but heavy use will still hit the cap — just wait a while.
- A home/residential connection works best. Datacenter and VPS IPs are
  challenged or rate-limited much more aggressively.
- On Android/Termux the high-performance HTTP transport falls back to a
  plain fetch implementation automatically; everything still works.
- Generated image responses are large (roughly 400–550 KB of JSON) because
  the image is returned as base64 — that is normal.
- This project is for personal use. It relies on duck.ai's public web
  behavior, which can change at any time; when it does, the version scrape
  and flow details in `src/scrapeClient.js` are where fixes land.

---

## Project structure

```
server.js            HTTP server: all endpoints, queue, cache, web pages
src/scrapeClient.js  The duck.ai backend client (version scrape, challenge
                     solver, chat/image/edit requests, stream parser)
src/duckClient.js    Mode router (scrape / mock / browser / upstream)
src/browserClient.js Optional browser-automation client
examples/            Calling the API from JavaScript and Python
capture.json         A recorded live duck.ai session (reference)
```

## License

MIT
