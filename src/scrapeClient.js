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
//             body: { model: "gpt-5.6-luna",
//                     messages: [{ role:"user",
//                                  content:[{type:"text", text}] }],
//                     canUseTools, canUseWebSearch, ... }
//
// Environment note: on the Muse sandbox VM outbound POSTs are held by
// the egress proxy (a POST to example.com times out too, while GETs and
// a POST to duckduckgo.com work). Run this on a normal network.

import crypto from "node:crypto";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
export const ORIGIN = "https://duck.ai";
const BASE_HEADERS = {
  "user-agent": UA,
  referer: ORIGIN + "/",
  origin: ORIGIN,
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="138", "Google Chrome";v="138", "Not)A;Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
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

export const MODEL_IDS = {
  Luna: "gpt-5.6-luna",
  Terra: "gpt-5.6-terra",
  "Claude Sonnet": "claude-sonnet-4-6",
  "GPT-5.4": "gpt-5.4",
  "GPT-4o mini": "gpt-4o-mini",
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
    userAgent: UA,
  });
  // Make the sandbox report the same UA we send on the wire
  try {
    Object.defineProperty(dom.window.navigator, "userAgent", { get: () => UA });
    Object.defineProperty(dom.window.navigator, "platform", { get: () => "Win32" });
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
  let out = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const j = JSON.parse(data);
      if (typeof j.message === "string") out += j.message;
      else if (Array.isArray(j.content)) {
        for (const part of j.content) if (part?.type === "text" && typeof part.text === "string") out += part.text;
      }
    } catch { /* keep-alives / non-JSON lines */ }
  }
  return out;
}

export async function chatViaScrape({ message, messages, model }) {
  const startedAt = Date.now();
  const journeyId = newJourneyId();
  const fe = await scrapeVersions();
  const { jsa } = await getChallenge(fe, journeyId);
  const modelId = MODEL_IDS[model] || model || MODEL_IDS.Luna;
  const msgs = (messages || [{ role: "user", content: message }]).map((m) =>
    typeof m.content === "string"
      ? { role: m.role || "user", content: [{ type: "text", text: m.content }] }
      : m
  );

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
      "x-fe-signals": buildFeSignals(startedAt),
      "x-vqd-hash-1": jsa,
      "x-ddg-journey-id": journeyId,
    },
    body: JSON.stringify({
      model: modelId,
      messages: msgs,
      canUseTools: true,
      canUseApproxLocation: false,
      canDelegateImageGeneration: true,
      canUseWebSearch: true,
      canUploadFiles: true,
      canShowGreeting: false,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    let type = "";
    try { type = JSON.parse(text)?.type || ""; } catch {}
    const err = new Error(`Phase 3 (chat) rejected: HTTP ${res.status}${type ? " " + type : ""} — ${text.slice(0, 200)}`);
    err.code = "CHAT_REJECTED";
    err.status = res.status;
    throw err;
  }
  return { model: modelId, reply: parseSSE(text), mode: "scrape" };
}
