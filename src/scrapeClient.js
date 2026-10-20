// Scrape backend for duck.ai — direct HTTP, NO browser automation.
//
// Flow (all three phases verified live on 2026-10-20, see capture.json):
//   Phase 1 — GET https://duck.ai/
//             Scrape <html data-version-tag="..." data-version-sha="...">
//             -> x-fe-version = "<tag>-<sha>"
//             (the frontend itself sets __DDG_BE_VERSION__ / __DDG_FE_CHAT_HASH__
//              from exactly these two attributes)
//   Phase 2 — GET https://duckduckgo.com/duckchat/v1/status
//             header: x-vqd-accept: 1
//             response header x-vqd-hash-1 = base64 JavaScript challenge.
//             Decode it and run it in a JSDOM sandbox (it measures DOM and
//             returns { server_hashes, client_hashes, signals, meta }),
//             then base64(JSON.stringify(result)) is the x-vqd-hash-1
//             header for the chat request.
//   Phase 3 — POST https://duckduckgo.com/duckchat/v1/chat  (SSE stream)
//             headers: x-fe-version, x-vqd-hash-1
//             body: { model, messages, metadata, canUseTools }
//
// Known limit (verified): Phase 3 currently answers 418 ERR_CHALLENGE from
// this sandbox — the server is stricter than the Phase-2 hash alone
// (the current frontend also sends x-fe-signals and extra tokens).
// Phases 1-2 work end to end; Phase 3 is wired and reports the server's
// error honestly instead of faking a reply.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const BASE_HEADERS = {
  "user-agent": UA,
  referer: "https://duckduckgo.com/",
  "accept-language": "en-US,en;q=0.9",
};

export const MODEL_IDS = {
  Luna: "gpt-5.6-luna", // observed in the live session + scraped JS bundle
  Terra: "gpt-5.6-terra",
  "Claude Sonnet": "claude-sonnet-4-6",
  "GPT-5.4": "gpt-5.4",
  "GPT-4o mini": "gpt-4o-mini",
};

export async function scrapeVersions() {
  const res = await fetch("https://duck.ai/", { headers: BASE_HEADERS });
  if (!res.ok) throw new Error(`Phase 1 (HTML scrape) failed: HTTP ${res.status}`);
  const html = await res.text();
  const tag = html.match(/data-version-tag="([^"]+)"/)?.[1];
  const sha = html.match(/data-version-sha="([^"]+)"/)?.[1];
  if (!tag || !sha) throw new Error("Phase 1: data-version-tag / data-version-sha not found in duck.ai HTML");
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  return { tag, sha, feVersion: `${tag}-${sha}`, scripts };
}

export async function getChallenge(fe) {
  const res = await fetch("https://duckduckgo.com/duckchat/v1/status", {
    headers: { ...BASE_HEADERS, "x-vqd-accept": "1" },
  });
  if (!res.ok) throw new Error(`Phase 2 (status) failed: HTTP ${res.status}`);
  const b64 = res.headers.get("x-vqd-hash-1");
  if (!b64) throw new Error("Phase 2: x-vqd-hash-1 header missing");
  const challengeJs = Buffer.from(b64, "base64").toString("utf8");

  let JSDOM;
  try {
    ({ JSDOM } = await import("jsdom"));
  } catch {
    const err = new Error("jsdom is not installed. Run: npm install");
    err.code = "JSDOM_MISSING";
    throw err;
  }
  const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
    url: "https://duckduckgo.com/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  dom.window.__DDG_BE_VERSION__ = fe.tag;
  dom.window.__DDG_FE_CHAT_HASH__ = fe.sha;
  const result = await dom.window.eval(challengeJs);
  dom.window.close();
  if (!result?.server_hashes) throw new Error("Phase 2: challenge did not return server_hashes");
  return {
    hashHeader: Buffer.from(JSON.stringify(result)).toString("base64"),
    meta: result.meta,
    serverHashes: result.server_hashes.length,
    clientHashes: Array.isArray(result.client_hashes) ? result.client_hashes.length : 0,
  };
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
    } catch { /* keep-alives / non-JSON lines */ }
  }
  return out;
}

export async function chatViaScrape({ message, messages, model }) {
  const fe = await scrapeVersions();
  const ch = await getChallenge(fe);
  const modelId = MODEL_IDS[model] || model || MODEL_IDS.Luna;
  const msgs = messages || [{ role: "user", content: message }];

  const res = await fetch("https://duckduckgo.com/duckchat/v1/chat", {
    method: "POST",
    headers: {
      ...BASE_HEADERS,
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-fe-version": fe.feVersion,
      "x-vqd-hash-1": ch.hashHeader,
    },
    body: JSON.stringify({
      model: modelId,
      metadata: { toolChoice: { NewsSearch: false, VideosSearch: false } },
      messages: msgs,
      canUseTools: true,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    let type = "";
    try { type = JSON.parse(text)?.type || ""; } catch {}
    const err = new Error(
      `Phase 3 (chat) rejected: HTTP ${res.status}${type ? " " + type : ""}. ` +
      (res.status === 418
        ? "The server wants a stronger challenge proof than the Phase-2 hash alone (current frontend also sends x-fe-signals + extra tokens)."
        : text.slice(0, 200))
    );
    err.code = "CHAT_REJECTED";
    err.status = res.status;
    throw err;
  }
  return { model: modelId, reply: parseSSE(text), mode: "scrape" };
}
