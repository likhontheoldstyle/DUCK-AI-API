import crypto from "node:crypto";

const UA_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const UA_ANDROID =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36";

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
  Luna: "gpt-6-luna",
  "GPT-5.4 mini": "gpt-5.4-mini",
  "Claude Haiku": "claude-haiku-4-5",
  Mistral: "mistral-small-2603",
  Gemma: "tinfoil/gemma4-31b",
  "gpt-oss": "tinfoil/gpt-oss-120b",
  Terra: "gpt-5.6-terra",
  "Claude Sonnet": "claude-sonnet-4-6",
};
export const PAID_MODELS = ["Terra", "Claude Sonnet"];

export let LAST_RAW = null;
export function getLastRaw() { return LAST_RAW; }

export function newJourneyId() {
  return crypto.randomBytes(16).toString("hex");
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

export function parseSSERich(text) {
  let out = "";
  const images = [];
  let title = null;
  let revisedPrompt = null;
  const b64Candidates = [];
  const pushImg = (v) => { if (typeof v === "string" && v && !images.includes(v)) images.push(v); };
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const j = JSON.parse(data);

      if (j.role === "tool-invocation" && j.toolName === "GenerateImage" && typeof j.toolArguments === "string") {
        try { revisedPrompt = JSON.parse(j.toolArguments)?.imageGenPrompt || revisedPrompt; } catch {}
      }
      if (j.role === "ui-component" && j.name === "generate-image" && j.data) {
        if (j.data.type === "image-title" && j.data.title) title = j.data.title;
        if (typeof j.data.b64Image === "string" && j.data.b64Image.length > 100) b64Candidates.push(j.data.b64Image);
        if (typeof j.data.url === "string") pushImg(j.data.url);
      }
      const parts = Array.isArray(j.content) ? j.content : Array.isArray(j.parts) ? j.parts : [];
      if (typeof j.message === "string") out += j.message;
      for (const part of parts) {
        if (!part) continue;
        if (part.type === "text" && typeof part.text === "string") out += part.text;
        if (part.type === "image" || part.type === "generated_image") {
          pushImg(part.image || part.url || part.dataUrl || part.src);
        }
      }
    } catch {  }
  }
  if (b64Candidates.length) {

    const best = b64Candidates.reduce((a, b) => (b.length > a.length ? b : a));
    const mime = best.startsWith("/9j/") ? "image/jpeg" : best.startsWith("iVBOR") ? "image/png" : "image/jpeg";
    images.unshift(`data:${mime};base64,${best}`);
  }
  for (const m of out.matchAll(/!\[[^\]]*\]\((https?:[^)\s]+)\)/g)) pushImg(m[1]);
  for (const m of text.matchAll(/https?:[^\s"')]+?\.(?:png|jpe?g|webp)(?:\?[^\s"')]*)?/gi)) pushImg(m[0]);

  for (const m of text.matchAll(/https?:[^\s"')]*duckchat[^\s"')]*\/(?:file|image|generated)[^\s"')]*/gi)) pushImg(m[0]);
  for (const m of text.matchAll(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{40,}/g)) pushImg(m[0].slice(0, 80) + "…(base64)");
  return { text: out, images, title, revisedPrompt, eventShapes: summarizeEvents(text) };
}

export function summarizeEvents(text) {
  const shapes = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const j = JSON.parse(data);
      const partTypes = (Array.isArray(j.content) ? j.content : Array.isArray(j.parts) ? j.parts : [])
        .map((x) => x?.type).filter(Boolean).join(",");
      const key = [j.action || "", j.type || "", partTypes, Object.keys(j).slice(0, 6).join("+")].join("|");
      shapes.set(key, (shapes.get(key) || 0) + 1);
    } catch { shapes.set("non-json", (shapes.get("non-json") || 0) + 1); }
  }
  return [...shapes.entries()].map(([shape, count]) => ({ shape, count })).slice(0, 12);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


const BODY_VARIANTS = [
  { name: "v2-meta+reasoning", extra: { metadata: {}, reasoningEffort: "none" } },
  { name: "v1-base", extra: {} },
  { name: "v3-greeting", extra: { metadata: {}, reasoningEffort: "none", canShowGreeting: true } },
];

const OSS_VARIANTS = [
  { name: "oss-low-null", extra: { metadata: {}, reasoningEffort: "low", canUseWebSearch: null, canUploadFiles: null } },
  { name: "oss-low", extra: { metadata: {}, reasoningEffort: "low" } },
  { name: "oss-low-nometa", extra: { reasoningEffort: "low", canUseWebSearch: null, canUploadFiles: null } },
];

async function chatAttempt({ msgs, modelId, fe, variant, metadata }) {
  const startedAt = Date.now();
  const journeyId = newJourneyId();
  const { jsa } = await getChallenge(fe, journeyId);

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
      canUseWebSearch: variant.extra.canUseWebSearch ?? true,
      canUploadFiles: variant.extra.canUploadFiles ?? true,
      canShowGreeting: variant.extra.canShowGreeting ?? false,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    let type = "";
    try { type = JSON.parse(text)?.type || ""; } catch {}
    if (type === "ERR_MODEL_RESTRICTED") {
      const err = new Error(`Model "${modelId}" is restricted: it needs a paid DuckDuckGo subscription. Free models: Luna, GPT-5.4 mini, Claude Haiku, Mistral, gpt-oss, Gemma.`);
      err.code = "MODEL_RESTRICTED";
      err.status = res.status;
      err.type = type;
      throw err;
    }
    const err = new Error(`Phase 3 (chat) rejected: HTTP ${res.status}${type ? " " + type : ""} — ${text.slice(0, 200)}`);
    err.code = "CHAT_REJECTED";
    err.status = res.status;
    err.type = type;
    throw err;
  }
  LAST_RAW = { at: new Date().toISOString(), model: modelId, image: !!metadata?.toolChoice, variant: variant.name, text };
  const rich = parseSSERich(text);
  return { model: modelId, reply: rich.text, images: rich.images, title: rich.title,
           revised_prompt: rich.revisedPrompt, mode: "scrape",
           debug: { bytes: text.length, events: rich.eventShapes } };
}

export async function chatViaScrape({ message, messages, model, image = false, imageData, imageMime }) {

  const metadata = image ? { toolChoice: { GenerateImage: true } } : undefined;
  const fe = await scrapeVersions();
  const modelId = MODEL_IDS[model] || model || MODEL_IDS.Luna;
  let msgs = (messages || [{ role: "user", content: message }]).map((m) =>
    typeof m.content === "string"
      ? { role: m.role || "user", content: [{ type: "text", text: m.content }] }
      : m
  );
  let imgShapes = null;
  if (imageData) {
    const mime = imageMime || (imageData.startsWith("data:") ? imageData.slice(5, imageData.indexOf(";")) : "image/jpeg");
    const uri = imageData.startsWith("data:") ? imageData : `data:${mime};base64,${imageData}`;
    const raw = uri.slice(uri.indexOf(",") + 1);
    const text = typeof message === "string" && message ? message : "Edit this image";
    imgShapes = [
      { type: "image", mimeType: mime, image: uri },
      { type: "image", mimeType: mime, image: raw },
    ];
    msgs = [{ role: "user", content: [imgShapes[0], { type: "text", text }] }];
  }

  const retriesPerVariant = Math.max(1, Number(process.env.DUCK_RETRIES || 2));
  const variants = modelId === "tinfoil/gpt-oss-120b" ? OSS_VARIANTS : BODY_VARIANTS;
  let lastErr;
  for (const variant of variants) {
    for (let attempt = 1; attempt <= retriesPerVariant; attempt++) {
      try {
        let useMsgs = msgs;
        if (imgShapes) {
          const shape = imgShapes[(attempt - 1) % imgShapes.length];
          const parts = attempt >= 3 ? [msgs[0].content[1], shape] : [shape, msgs[0].content[1]];
          useMsgs = [{ role: "user", content: parts }];
          console.log(`[duck-ai-api] image part shape ${(attempt - 1) % imgShapes.length} (${shape.image.startsWith("data:") ? "data-url" : "raw-b64"})`);
        }
        const out = await chatAttempt({ msgs: useMsgs, modelId, fe, variant, metadata });
        console.log(`[duck-ai-api] variant ${variant.name} attempt ${attempt} -> OK`);
        out.variant = variant.name;
        out.attempts = attempt;
        return out;
      } catch (e) {
        lastErr = e;
        console.log(`[duck-ai-api] variant ${variant.name} attempt ${attempt} -> HTTP ${e.status || "?"} ${e.type || ""}`);
        if (e.status === 400) break;
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
