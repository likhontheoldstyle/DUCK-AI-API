<div align="center">

<img src="https://capsule-render.vercel.app/api?type=rect&color=141E30,243B55&height=160&section=header&text=DUCK-AI-API&fontSize=42&fontColor=ffffff&fontAlignY=42&desc=Chat%2C%20image%20generation%20and%20image%20editing%20via%20duck.ai%20%E2%80%94%20no%20API%20key%2C%20no%20account&descAlignY=62&descSize=16" width="100%"/>

<a href="https://git.io/typing-svg"><img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=22&pause=1000&color=6366F1&center=true&vCenter=true&width=560&lines=Welcome+to+DUCK-AI-API;6+Free+AI+Models+%7C+Image+Gen+%7C+Image+Edit;OpenAI-Compatible+%7C+No+API+Key+Needed;Built+with+Node.js" alt="Typing SVG" /></a>

<br/>

![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?style=for-the-badge&logo=node.js&logoColor=white)
![npm](https://img.shields.io/badge/npm-10.x-CB3837?style=for-the-badge&logo=npm&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

</div>

---

## 📖 About

**DUCK-AI-API** is a local API server that gives you programmatic access to the AI models on [duck.ai](https://duck.ai) (DuckDuckGo AI Chat) — text chat, image generation, and image editing — with **no API key and no account required**.

It talks to duck.ai's backend the same way the official web frontend does: it scrapes the current frontend version, solves the request challenge automatically, and streams the response back to you as clean JSON.

**Base URL (default):** `http://localhost:3000`

---

## ✨ Features

- 💬 **6 free chat models** — GPT-6 Luna, GPT-5.4 mini, Claude Haiku, Mistral Small, Gemma 4, and gpt-oss 120B
- 🖼️ **Image generation** — powered behind the scenes by OpenAI's gpt-image model
- ✏️ **Image editing** — upload a photo and describe the edit
- 🔌 **Three API styles** — simple GET endpoints, plain POST JSON, and a full OpenAI-compatible API with streaming
- 🤖 **Fully automatic request flow** — version scraping and challenge solving are handled internally; no tokens or cookies to manage
- 🛡️ **Built-in resilience** — automatic retries, a serial request queue, rate-limit waiting, and a short response cache
- 🌐 **Web test pages** — a chat page, an image viewer page, and an image edit page, all served by the server itself
- 📱 **Works everywhere Node.js runs** — Windows, Linux, macOS, and Android (Termux)

---

## 🧰 Tech Stack

| Technology | Version |
|---|---|
| Node.js | 20.x |
| npm | 10.x |
| JavaScript | ES2022 |

---

## 🚀 Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/likhontheoldstyle/DUCK-AI-API.git
cd DUCK-AI-API
```

### 2. Install dependencies

```bash
npm install
```

### 3. Run the project

```bash
npm start
```

Then open <http://localhost:3000> in a browser for the test page, or call the API directly:

```bash
curl "http://localhost:3000/chat?message=Hello&model=Luna"
```

---

## 🤖 Models

| Name (use this in requests) | Model ID | Provider | Notes |
|---|---|---|---|
| `Luna` | `gpt-6-luna` | OpenAI | Default. Best all-rounder, reasoning |
| `GPT-5.4 mini` | `gpt-5.4-mini` | OpenAI | Small and fast |
| `Claude Haiku` | `claude-haiku-4-5` | Anthropic | Fast Claude, natural writing |
| `Mistral` | `mistral-small-2603` | Mistral AI | General chat, low moderation |
| `Gemma` | `tinfoil/gemma4-31b` | Google | Privacy-focused (encrypted via Tinfoil) |
| `gpt-oss` | `tinfoil/gpt-oss-120b` | OpenAI (open weights) | Encrypted reasoning model |
| `Terra` | `gpt-5.6-terra` | OpenAI | **Paid** — needs a DuckDuckGo subscription |
| `Claude Sonnet` | `claude-sonnet-4-6` | Anthropic | **Paid** — needs a DuckDuckGo subscription |

You can pass either the friendly name (`"Luna"`) or the raw model ID (`"gpt-6-luna"`). Paid models return a clear `MODEL_RESTRICTED` error on free (anonymous) access.

> **About image generation and editing:** the chat models do not render images themselves. The chat model rewrites your prompt into a detailed one, then delegates the actual rendering to a dedicated image model (OpenAI's gpt-image, served through DuckDuckGo). Responses include the model's `title` and the `revised_prompt` it used.

---

## 📡 API Endpoints

### Web pages (open in a browser)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/` | Chat test page with a model selector and an image-generation toggle |
| GET | `/image-view?prompt=...` | Generates an image and shows it on a page (with title and revised prompt) |
| GET | `/edit` | Image edit page — pick a photo, describe the edit, get the edited image |
| GET | `/last-image` | Serves the most recently generated/edited image as a raw JPEG |

### Simple GET API (browser-friendly)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/chat?message=Hello&model=Luna` | Chat with a model (`message` can also be `msg` or `q`) |
| GET | `/image?prompt=...&model=Luna` | Generate an image from a text prompt |

### POST API

| Method | Endpoint | Description |
|---|---|---|
| POST | `/chat` | Chat — `{ "message": "...", "model": "Luna" }`, or a `messages` array for multi-turn |
| POST | `/image` | Image generation — `{ "prompt": "...", "model": "Luna" }` |
| POST | `/image-edit` | Image editing — `{ "image": "data:image/png;base64,...", "prompt": "...", "model": "Luna" }` |

For `/image-edit`, `image` is a base64 string or a full data URI of the source photo (PNG or WebP recommended; large photos are best downscaled to about 1024 px on the longest side, like the official frontend does).

### OpenAI-compatible API

| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/chat/completions` | Chat completions; `"stream": true` for SSE streaming. Send a top-level `"image": true` field to generate an image instead of text |
| GET | `/v1/models` | Lists all models |
| POST | `/v1/images/generations` | Image generation; returns OpenAI-style `b64_json` |

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

### Utility endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Server status, mode, and model list |
| GET | `/models` | Friendly name → model ID map |
| GET | `/scrape-status` | Diagnostics: transport, device profile, user agent, and live checks of the version scrape and challenge steps |
| GET | `/debug-last` | The raw stream of the most recent request (for debugging empty replies) |
| GET | `/capture` | The built-in capture record |

### Example Request

```bash
curl "http://localhost:3000/chat?message=Hello&model=Luna"
```

### Example Response

```json
{
  "status": true,
  "id": "chatcmpl-a1b2c3d4",
  "object": "chat.completion",
  "model": "gpt-6-luna",
  "reply": "Hello! How can I help?",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hello! How can I help?" },
      "finish_reason": "stop"
    }
  ],
  "time": "2026-10-21T08:51:00.000Z",
  "author": "LIKHON AHMED",
  "signature": "N19H0M"
}
```

Image endpoints return `images` (an array of `data:image/jpeg;base64,...` URLs), plus `title` and `revised_prompt`.

---

## ⚙️ Configuration

Set these environment variables before starting the server:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `DUCK_MODE` | `scrape` | `scrape` (real duck.ai backend), `mock` (offline test replies), `browser`, or `upstream` |
| `DUCK_MODEL` | `Luna` | Default model when a request doesn't specify one |
| `DUCK_RETRIES` | `2` | Retries per request variant on challenge rejection |
| `DUCK_MIN_INTERVAL_MS` | `3000` | Minimum gap between upstream requests (requests are queued serially) |
| `DUCK_CACHE_TTL_MS` | `600000` | How long identical requests are served from cache (10 min) |
| `DUCK_429_WAIT_MS` | `60000` | On a rate limit, wait this long and retry once automatically |
| `DUCK_UA` | auto | Override the user agent / device profile (an Android profile is used automatically on Termux) |

```bash
PORT=8080 DUCK_MODEL="Claude Haiku" npm start
```

---

## 🔍 How It Works

Every chat or image request runs the same three-phase flow the official duck.ai frontend uses:

1. **Version scrape** — `GET https://duck.ai/` and read the current frontend version tag and SHA from the page. These rotate often, so they are scraped fresh and cached only briefly.
2. **Challenge** — `GET https://duck.ai/duckchat/v1/status` returns a JavaScript anti-bot challenge. The server executes it in a sandbox and computes the required SHA-256 based proof header.
3. **Chat** — `POST https://duck.ai/duckchat/v1/chat` with the solved headers and a body built exactly like the frontend's (text part first, then any image part). The response is an SSE stream, which the server parses into text, tool calls, and — for image requests — the generated image parts.

For image uploads, the request mirrors the frontend precisely: the user message content is `[{ type: "text" }, { type: "image", mimeType, image }]` with the image as a data URL.

Errors are handled automatically where possible: challenge rejections are retried with fresh proofs and alternate body shapes, and rate limits trigger one patient wait-and-retry.

---

## ⚠️ Limits and Notes

- **Anonymous quota** — duck.ai rate-limits free access per IP address (`429 ERR_RATE_LIMIT`). The server queues requests, spaces them out, and caches repeats, but heavy use will still hit the cap — just wait a while.
- A home/residential connection works best. Datacenter and VPS IPs are challenged or rate-limited much more aggressively.
- On Android/Termux the high-performance HTTP transport falls back to a plain fetch implementation automatically; everything still works.
- Generated image responses are large (roughly 400–550 KB of JSON) because the image is returned as base64 — that is normal.
- This project is for personal use. It relies on duck.ai's public web behavior, which can change at any time; when it does, the version scrape and flow details in `src/scrapeClient.js` are where fixes land.

---

## 📁 Project Structure

```
DUCK-AI-API/
├── server.js            # HTTP server: all endpoints, queue, cache, web pages
├── src/
│   ├── scrapeClient.js  # duck.ai backend client (version scrape, challenge
│   │                    # solver, chat/image/edit requests, stream parser)
│   ├── duckClient.js    # Mode router (scrape / mock / browser / upstream)
│   └── browserClient.js # Optional browser-automation client
├── examples/            # Calling the API from JavaScript and Python
├── capture.json         # A recorded live duck.ai session (reference)
├── package.json
└── README.md
```

---

## 🤝 Contributing

Contributions, issues and feature requests are welcome.
Feel free to open an issue or submit a pull request.

---

## 👤 Author

**LIKHON AHMED**

- GitHub: [@likhontheoldstyle](https://github.com/likhontheoldstyle)

---

## 📄 License

This project is licensed under the **MIT License**.

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=rect&color=141E30,243B55&height=80&section=footer" width="100%"/>

**⭐ Star this repository if you find it useful!**

</div>
