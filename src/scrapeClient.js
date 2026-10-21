// Scrape backend for duck.ai — direct HTTP, NO browser automation.
// Request shape reverse-engineered from duck.ai's own JS bundle
// (entry.duckai.*.js, scraped 2026-10-20) and verified phase by phase.
//
//   Phase 1 — GET https://duck.ai/
//             Scrape <html data-version-tag data-version-sha>
//             -> x-fe-version = "<tag>-<sha>"
//   Phase 2 — GET https://duck.ai/duckchat/v1/status
//             headers: x-vqd-accept: 1, x-ddg-journey-id: <32 hex>
//             Response header X-Vqd-Hash-1 = base64 JS challenge.
//             Solver (frontend module "wR"): run the challenge, then
//               client_hashes := SHA-256(each) as base64,
//               meta += { origin, stack, duration },
//               header value := btoa(JSON.stringify(result))
//   Phase 3 — POST https://duck.ai/duckchat/v1/chat  (SSE)
//             headers: X-Vqd-Hash-1: <solved jsa>, x-fe-version,
//                      x-fe-signals: btoa(JSON({start, events, end})),
//                      x-ddg-journey-id, x-duckai-response-id, ...
//             body: { model: "gpt-6-luna",
//                     messages: [{ role:"user",
//                                  content:[{type:"text", text}] }],
//                     canUseTools, canUseWebSearch, ... }
//
// Environment note: on the Muse sandbox VM outbound POSTs are held by
// the egress proxy (a POST to example.com times out too, while GETs and
// a POST to duckduckgo.com work). Run this on a normal network.

import crypto from "node:crypto";

const UA_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const UA_ANDROID =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36";

// Device profile: the UA, client-hints and the sandbox's navigator values
// must all tell the SAME story — a Windows UA sent from an Android phone
// (Termux) is a fingerprint mismatch that can hurt the challenge verdict.
// Auto-picked by platform; override with DUCK_UA (and DUCK_NAV_PLATFORM).
export function deviceProfile() {
  if (process.env.DUCK_UA) {
    return {
      name: "custom (DUCK_UA)",
      ua: process.env.DUCK_UA,
      navPlatform: process.env.DUCK_NAV_PLATFORM || "Win32",
      chPlatform: process.env.DUCK_UA.includes("Android") ? '"Android"' : '"Windows"',
      chMobile: process.env.DUCK_UA.includes("Mobile") ? "?1" : "?0",
    };
  }
  if (process.platform === "android") {
    return {
      name: "android",
      ua: UA_ANDROID,
      navPlatform: "Linux armv8l",
      chPlatform: '"Android"',
      chMobile: "?1",
    };
  }
  return {
    name: "windows",
    ua: UA_WINDOWS,
    navPlatform: "Win32",
    chPlatform: '"Windows"',
    chMobile: "?0",
  };
}

export const PROFILE = deviceProfile();
export const ORIGIN = "https://duck.ai";
const BASE_HEADERS = {
  "user-agent": PROFILE.ua,
  referer: ORIGIN + "/",
  origin: ORIGIN,
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="138", "Google Chrome";v="138", "Not)A;Brand";v="99"',
  "sec-ch-ua-mobile": PROFILE.chMobile,
  "sec-ch-ua-platform": PROFILE.chPlatform,
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

// Transport: prefer impit (Chrome TLS/HTTP2 impersonation) when installed —
// a plain Node fetch has a Node TLS fingerprint, which challenge systems
// can tell apart from the Chrome UA we claim (a likely cause of 418).
// Falls back to global fetch if impit is unavailable.
let _transport = null;
export async function getTransport() {
  if (_transport) return _transport;
  try {
    const { Impit } = await import("impit");
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || undefined;
    const impit = new Impit({ browser: "chrome", proxyUrl, timeout: 120_000 });
    _transport = (url, opts) => impit.fetch(url, opts);
    _transport.kind = "impit-chrome";
  } catch {
    _transport = (url, opts) => fetch(url, opts);
    _transport.kind = "node-fetch";
  }
  return _transport;
}

// Model IDs scraped from duck.ai's own model list in its JS bundle
// (2026-10-20). NOTE: Luna's id is "gpt-6-luna" — the older "gpt-5.6-luna"
// id was replaced and the server rejects it with 400 ERR_BAD_REQUEST.
export const MODEL_IDS = {
  Luna: "gpt-6-luna",
  Terra: "gpt-5.6-terra",
  "Claude Sonnet": "claude-sonnet-4-6",
  "Claude Haiku": "claude-haiku-4-5",
  "GPT-5.4 mini": "gpt-5.4-mini",
  Mistral: "mistral-small-2603",
};

export function newJourneyId() {
  return crypto.randomBytes(16).toString("hex"); // frontend: x-ddg-journey-id
}

export async function scrapeVersions() {
  const f = await getTransport();
  const res = await f(ORIGIN + "/", { headers: BASE_HEADERS });
  if (!res.ok) throw new Error(`Phase 1 (HTML scrape) failed: HTTP ${res.status}`);
  const html = await res.text();
  const tag = html.match(/data-version-tag="([^"]+)"/)?.[1];
  const sha = html.match(/data-version-sha="([^"]+)"/)?.[1];
  if (!tag || !sha) throw new Error("Phase 1: data-version-tag / data-version-sha not found in duck.ai HTML");
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  return { tag, sha, feVersion: `${tag}-${sha}`, scripts };
}

async function solveChallenge(challengeB64, fe) {
  let JSDOM;
  try {
    ({ JSDOM } = await import("jsdom"));
  } catch {
    const err = new Error("jsdom is not installed. Run: npm install");
    err.code = "JSDOM_MISSING";
    throw err;
  }
  const started = Date.now();
  const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
    url: ORIGIN + "/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    userAgent: PROFILE.ua,
  });
  // Make the sandbox report the same UA we send on the wire
  try {
    Object.defineProperty(dom.window.navigator, "userAgent", { get: () => PROFILE.ua });
    Object.defineProperty(dom.window.navigator, "platform", { get: () => PROFILE.navPlatform });
    Object.defineProperty(dom.window.navigator, "webdriver", { get: () => false });
  } catch {}
  dom.window.__DDG_BE_VERSION__ = fe.tag;
  dom.window.__DDG_FE_CHAT_HASH__ = fe.sha;
  const decoded = Buffer.from(challengeB64, "base64").toString("utf8");
  const raw = await dom.window.eval(decoded);
  dom.window.close();
  if (!raw || !("client_hashes" in raw)) throw new Error("Phase 2: challenge result missing client_hashes");

  // The frontend solver transforms the raw result before sending it:
  const clientHashes = await Promise.all(
    raw.client_hashes.map(async (h) =>
      crypto.createHash("sha256").update(String(h)).digest().toString("base64"))
  );
  const stack =
    "Error\n    at l (https://duck.ai/dist/duckai-dist/entry.duckai.js:1:1)\n    at async Promise.all (index 0)";
  const solved = {
    ...raw,
    client_hashes: clientHashes,
    meta: { ...(raw.meta || {}), origin: ORIGIN, stack, duration: String(Date.now() - started) },
  };
  return Buffer.from(JSON.stringify(solved)).toString("base64");
}

export async function getChallenge(fe, journeyId) {
  const f = await getTransport();
  const res = await f(`${ORIGIN}/duckchat/v1/status`, {
    headers: { ...BASE_HEADERS, "cache-control": "no-store", "x-vqd-accept": "1", "x-ddg-journey-id": journeyId },
  });
  if (!res.ok) throw new Error(`Phase 2 (status) failed: HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  const b64 = res.headers.get("x-vqd-hash-1");
  if (!b64) throw new Error("Phase 2: X-Vqd-Hash-1 header missing");
  const jsa = await solveChallenge(b64, fe);
  return { jsa, statusBody: body };
}

export function buildFeSignals(startedAt, events = []) {
  const summary = {
    start: startedAt,
    events: events.length ? events : [{ name: "impression", delta: 900 }, { name: "startNewChat_free", delta: 1100 }],
    end: Date.now() - startedAt,
  };
  return Buffer.from(JSON.stringify(summary)).toString("base64");
}

export function parseSSE(text) {
  return parseSSERich(text).text;
}

// Richer parse: text plus any generated images found in the stream.
// Image parts arrive as content parts like {type:"image", image|url|dataUrl}
// or as markdown image links inside text parts.
export function parseSSERich(text) {
  let out = "";
  const images = [];
  const pushImg = (v) => { if (typeof v === "string" && v && !images.includes(v)) images.push(v); };
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const j = JSON.parse(data);
      const parts = Array.isArray(j.content) ? j.content : Array.isArray(j.parts) ? j.parts : [];
      if (typeof j.message === "string") out += j.message;
      for (const part of parts) {
        if (!part) continue;
        if (part.type === "text" && typeof part.text === "string") out += part.text;
        if (part.type === "image" || part.type === "generated_image") {
          pushImg(part.image || part.url || part.dataUrl || part.src);
        }
      }
    } catch { /* keep-alives / non-JSON lines */ }
  }
  for (const m of out.matchAll(/!\[[^\]]*\]\((https?:[^)\s]+)\)/g)) pushImg(m[1]);
  for (const m of text.matchAll(/https?:[^\s"')]+?\.(?:png|jpe?g|webp)(?:\?[^\s"')]*)?/gi)) pushImg(m[0]);
  return { text: out, images };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Body variants tried in order when the server answers 400 ERR_BAD_REQUEST.
// The frontend body always contains `metadata` and `reasoningEffort` keys
// (values can be empty), which the first version of this client omitted.
const BODY_VARIANTS = [
  { name: "v1-base", extra: {} },
  { name: "v2-meta+reasoning", extra: { metadata: {}, reasoningEffort: "none" } },
  { name: "v3-greeting", extra: { metadata: {}, reasoningEffort: "none", canShowGreeting: true } },
];

async function chatAttempt({ msgs, modelId, fe, variant, metadata }) {
  const startedAt = Date.now();
  const journeyId = newJourneyId();
  const { jsa } = await getChallenge(fe, journeyId);

  // Human-like pacing: a real browser loads the page, solves the challenge,
  // and only sends the chat a few seconds later. Signals must match that.
  const elapsed = Date.now() - startedAt;
  if (elapsed < 2600) await sleep(2600 - elapsed + Math.floor(Math.random() * 700));

  const signals = {
    start: startedAt,
    events: [
      { name: "impression", delta: 700 + Math.floor(Math.random() * 500) },
      { name: "startNewChat_free", delta: 1900 + Math.floor(Math.random() * 600) },
    ],
    end: Date.now() - startedAt,
  };

  const f = await getTransport();
  const res = await f(`${ORIGIN}/duckchat/v1/chat`, {
    method: "POST",
    headers: {
      ...BASE_HEADERS,
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-duckai-continuation": "resubmit-context",
      "x-duckai-consent-purposes": "user-location,image-generation,web-search",
      "x-duckai-tool-approval": "web-search",
      "x-duckai-response-id": crypto.randomUUID(),
      "x-fe-version": fe.feVersion,
      "x-fe-signals": Buffer.from(JSON.stringify(signals)).toString("base64"),
      "x-vqd-hash-1": jsa,
      "x-ddg-journey-id": journeyId,
    },
    body: JSON.stringify({
      model: modelId,
      ...((variant.extra.metadata !== undefined || metadata) ? { metadata: { ...(variant.extra.metadata || {}), ...(metadata || {}) } } : {}),
      messages: msgs,
      canUseTools: true,
      ...(variant.extra.reasoningEffort !== undefined ? { reasoningEffort: variant.extra.reasoningEffort } : {}),
      canUseApproxLocation: false,
      canDelegateImageGeneration: true,
      canUseWebSearch: true,
      canUploadFiles: true,
      canShowGreeting: variant.extra.canShowGreeting ?? false,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    let type = "";
    try { type = JSON.parse(text)?.type || ""; } catch {}
    const err = new Error(`Phase 3 (chat) rejected: HTTP ${res.status}${type ? " " + type : ""} — ${text.slice(0, 200)}`);
    err.code = "CHAT_REJECTED";
    err.status = res.status;
    err.type = type;
    throw err;
  }
  const rich = parseSSERich(text);
  return { model: modelId, reply: rich.text, images: rich.images, mode: "scrape" };
}

export async function chatViaScrape({ message, messages, model, image = false }) {
  // Image generation is the same chat call with a toolChoice metadata —
  // reverse-engineered from the frontend bundle: metadata:{toolChoice:{GenerateImage:true}}
  const metadata = image ? { toolChoice: { GenerateImage: true } } : undefined;
  const fe = await scrapeVersions();
  const modelId = MODEL_IDS[model] || model || MODEL_IDS.Luna;
  const msgs = (messages || [{ role: "user", content: message }]).map((m) =>
    typeof m.content === "string"
      ? { role: m.role || "user", content: [{ type: "text", text: m.content }] }
      : m
  );

  // Observed live: the challenge verdict is inconsistent — the same flow
  // sometimes gets 418 ERR_CHALLENGE and sometimes passes. So for each body
  // variant: retry on 418 with a fresh journey + fresh challenge; on 400
  // move to the next variant; any success reports which variant worked.
  const retriesPerVariant = Math.max(1, Number(process.env.DUCK_RETRIES || 2));
  let lastErr;
  for (const variant of BODY_VARIANTS) {
    for (let attempt = 1; attempt <= retriesPerVariant; attempt++) {
      try {
        const out = await chatAttempt({ msgs, modelId, fe, variant, metadata });
        console.log(`[duck-ai-api] variant ${variant.name} attempt ${attempt} -> OK`);
        out.variant = variant.name;
        out.attempts = attempt;
        return out;
      } catch (e) {
        lastErr = e;
        console.log(`[duck-ai-api] variant ${variant.name} attempt ${attempt} -> HTTP ${e.status || "?"} ${e.type || ""}`);
        if (e.status === 400) break; // deterministic for this variant; try next
        if (e.status !== 418 || attempt === retriesPerVariant) {
          if (e.status !== 418) throw e;
          break;
        }
        await sleep(1500 * attempt);
      }
    }
  }
  throw lastErr;
}
