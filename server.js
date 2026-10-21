import http from "node:http";
import { KNOWN_MODELS, sendUpstream } from "./src/duckClient.js";
import { chatViaBrowser } from "./src/browserClient.js";
import { chatViaScrape, scrapeVersions, getChallenge, newJourneyId, getTransport, MODEL_IDS, PROFILE } from "./src/scrapeClient.js";

const PORT = Number(process.env.PORT || 3000);
const MODE = process.env.DUCK_MODE || "scrape"; // scrape (default) | mock | browser | upstream

const CAPTURED = { model: "Luna", message: "hi", response: "Hi! How can I help?" };

// --- Upstream politeness layer (respects duck.ai's limits, never evades) ---
// 1) Serial queue + minimum gap between upstream calls (no bursts).
// 2) Short-lived cache so repeat questions don't spend quota.
// 3) On 429: wait (default 60s, DUCK_429_WAIT_MS) and retry ONCE — the
//    server absorbs the wait so callers just see a slower success.
const MIN_INTERVAL_MS = Number(process.env.DUCK_MIN_INTERVAL_MS || 3000);
const CACHE_TTL_MS = Number(process.env.DUCK_CACHE_TTL_MS || 600_000);
const WAIT_429_MS = Number(process.env.DUCK_429_WAIT_MS || 60_000);
const _cache = new Map();
let _queue = Promise.resolve();
let _lastCallAt = 0;
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enqueueScrape(args) {
  const key = JSON.stringify([args.model, args.image ? 1 : 0, args.messages || args.message]);
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve({ ...hit.out, cached: true });
  const run = async () => {
    const gap = MIN_INTERVAL_MS - (Date.now() - _lastCallAt);
    if (gap > 0) await _sleep(gap);
    try {
      _lastCallAt = Date.now();
      const out = await chatViaScrape(args);
      _cache.set(key, { at: Date.now(), out });
      return out;
    } catch (e) {
      if (e.status === 429 && WAIT_429_MS > 0) {
        console.log(`[duck-ai-api] 429 rate limit — waiting ${Math.round(WAIT_429_MS / 1000)}s, then one retry`);
        await _sleep(WAIT_429_MS);
        _lastCallAt = Date.now();
        const out = await chatViaScrape(args);
        _cache.set(key, { at: Date.now(), out });
        return out;
      }
      throw e;
    }
  };
  const p = _queue.then(run, run);
  _queue = p.catch(() => {});
  return p;
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
  });
}

const HOME_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DUCK-AI-API</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px}
#log{white-space:pre-wrap;border:1px solid #ccc;border-radius:8px;padding:12px;min-height:160px}
input,select,button{font-size:16px;padding:8px} #msg{width:70%}</style></head>
<body>
<h2>DUCK-AI-API — Chat Test</h2>
<p>Server is running. Type a message and press Send — this page calls <code>POST /chat</code> for you.</p>
<div id="log"></div>
<p><input id="msg" placeholder="Type your message, e.g. hi">
<select id="model"><option>Luna</option><option>Terra</option><option>Claude Sonnet</option><option>Claude Haiku</option><option>GPT-5.4 mini</option><option>Mistral</option></select>
<label><input type="checkbox" id="imgmode"> 🖼 Image</label>
<button id="send">Send</button></p>
<p style="color:#555">API endpoints: GET /health &nbsp; GET /models &nbsp; GET /scrape-status &nbsp; POST /chat &nbsp; POST /image</p>
<script>
const log=document.getElementById('log');
async function send(){
  const message=document.getElementById('msg').value.trim(); if(!message) return;
  const model=document.getElementById('model').value;
  const img=document.getElementById('imgmode').checked;
  log.textContent += 'You: '+message+(img?' [image]':'')+'\\nWaiting...\\n';
  try{
    const r=await fetch(img?'/image':'/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(img?{prompt:message,model}:{message,model})});
    const j=await r.json();
    if(img){
      log.textContent += (j.images&&j.images.length?('Images: '+j.images.join('  ')):(j.reply?('AI: '+j.reply):((r.status===200?'Accepted, but no image/text came back. Debug: ':'Error '+r.status+': ')+JSON.stringify(j.debug||j.error||j)))))+'\\n\\n';
    } else {
      log.textContent += (j.reply?('AI ('+(j.model||model)+'): '+j.reply):('Error '+r.status+': '+(j.error||JSON.stringify(j))))+'\\n\\n';
    }
  }catch(e){ log.textContent += 'Error: '+e.message+'\\n\\n'; }
}
document.getElementById('send').onclick=send;
document.getElementById('msg').addEventListener('keydown',e=>{if(e.key==='Enter')send()});
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(HOME_PAGE);
    }
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true, mode: MODE, models: Object.keys(MODEL_IDS),
        usage: 'POST /chat {"message":"hi","model":"Luna"}' });
    }
    if (req.method === "GET" && req.url === "/models") {
      return json(res, 200, { models: MODEL_IDS, known: KNOWN_MODELS });
    }
    if (req.method === "GET" && req.url === "/capture") return json(res, 200, CAPTURED);
    if (req.method === "GET" && req.url === "/scrape-status") {
      // Diagnostics: run Phase 1 + 2 live and show what was scraped (no chat sent)
      const fe = await scrapeVersions();
      const ch = await getChallenge(fe, newJourneyId());
      const transport = (await getTransport()).kind;
      return json(res, 200, { transport, deviceProfile: PROFILE.name, userAgent: PROFILE.ua, phase1: fe, phase2: { statusBody: ch.statusBody, jsaLength: ch.jsa.length, jsaPrefix: ch.jsa.slice(0, 24) + "…" } });
    }

    if (req.method === "POST" && req.url === "/chat") {
      const body = await readBody(req);
      const message = body.message || body.messages?.at(-1)?.content;
      if (!message) return json(res, 400, { error: 'Send {"message":"hi"} or {"messages":[...]}' });
      const model = body.model || process.env.DUCK_MODEL || "Luna";

      if (MODE === "scrape") {
        const out = await enqueueScrape({ message, messages: body.messages, model, image: !!body.image });
        return json(res, 200, out);
      }
      if (MODE === "browser") {
        const out = await chatViaBrowser({ message, model });
        return json(res, 200, { model: out.model, reply: out.reply, mode: "browser" });
      }
      if (MODE === "upstream") {
        const messages = body.messages || [{ role: "user", content: message }];
        const upstream = await sendUpstream({ model, messages });
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "text/event-stream" });
        return res.end(await upstream.text());
      }
      const reply = message.trim().toLowerCase() === "hi" ? CAPTURED.response : `[mock:${model}] You said: ${message}`;
      return json(res, 200, { model, reply, mode: "mock" });
    }
    // ---------- OpenAI-compatible API format ----------
    if (req.method === "GET" && req.url === "/v1/models") {
      const data = Object.entries(MODEL_IDS).map(([name, id]) => ({
        id, object: "model", created: 0, owned_by: "duck.ai", name,
      }));
      return json(res, 200, { object: "list", data });
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = await readBody(req);
      const oaiError = (status, message, code) =>
        json(res, status, { error: { message, type: "invalid_request_error", code: code || null } });
      if (!Array.isArray(body.messages) || !body.messages.length) {
        return oaiError(400, 'Send {"model":"gpt-6-luna","messages":[{"role":"user","content":"hi"}]}');
      }
      // Accept friendly names ("Luna") and raw ids ("gpt-6-luna") alike
      const modelIn = body.model || "Luna";
      const modelName = MODEL_IDS[modelIn] ? modelIn
        : Object.keys(MODEL_IDS).find((k) => MODEL_IDS[k] === modelIn) || modelIn;
      const messages = body.messages.map((m) => ({
        role: m.role || "user",
        content: typeof m.content === "string" ? m.content
          : Array.isArray(m.content) ? m.content.filter((p) => p?.type === "text").map((p) => p.text).join("") : "",
      }));
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";

      let out;
      if (MODE === "scrape") {
        out = await enqueueScrape({ message: lastUser, messages, model: modelName, image: false });
      } else if (MODE === "browser") {
        const b = await chatViaBrowser({ message: lastUser, model: modelName });
        out = { model: MODEL_IDS[modelName] || modelName, reply: b.reply };
      } else {
        out = { model: MODEL_IDS[modelName] || modelName, reply: lastUser.trim().toLowerCase() === "hi" ? CAPTURED.response : `[mock:${modelName}] You said: ${lastUser}` };
      }
      const modelId = MODEL_IDS[modelName] || out.model || modelName;
      const id = "chatcmpl-" + Math.random().toString(36).slice(2, 24);
      const created = Math.floor(Date.now() / 1000);
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const chunk = (delta, finish) => "data: " + JSON.stringify({
          id, object: "chat.completion.chunk", created, model: modelId,
          choices: [{ index: 0, delta, finish_reason: finish }],
        }) + "\n\n";
        res.write(chunk({ role: "assistant", content: "" }, null));
        res.write(chunk({ content: out.reply || "" }, null));
        res.write(chunk({}, "stop"));
        return res.end("data: [DONE]\n\n");
      }
      return json(res, 200, {
        id, object: "chat.completion", created, model: modelId,
        choices: [{ index: 0, message: { role: "assistant", content: out.reply || "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    if (req.method === "POST" && req.url === "/v1/images/generations") {
      const body = await readBody(req);
      if (!body.prompt) return json(res, 400, { error: { message: 'Send {"prompt":"a cat in space"}', type: "invalid_request_error", code: null } });
      if (MODE !== "scrape") return json(res, 400, { error: { message: "Image generation needs DUCK_MODE=scrape", type: "invalid_request_error", code: null } });
      const out = await enqueueScrape({ message: body.prompt, model: body.model || "Luna", image: true });
      return json(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data: (out.images || []).map((url) => ({ url })),
        reply: out.reply || undefined,
      });
    }

    if (req.method === "POST" && req.url === "/image") {      const body = await readBody(req);
      const prompt = body.prompt || body.message;
      if (!prompt) return json(res, 400, { error: 'Send {"prompt":"a cat in space"}' });
      const model = body.model || process.env.DUCK_MODEL || "Luna";
      if (MODE !== "scrape") return json(res, 400, { error: "Image generation needs DUCK_MODE=scrape" });
      const out = await enqueueScrape({ message: prompt, model, image: true });
      return json(res, 200, { model: out.model, prompt, images: out.images || [], reply: out.reply, mode: "scrape", variant: out.variant, debug: out.debug });
    }
    return json(res, 404, { error: "Not found. Try GET /health, GET /models, GET /scrape-status, POST /chat, POST /image" });
  } catch (e) {
    const status = ["PLAYWRIGHT_MISSING", "JSDOM_MISSING", "MISSING_UPSTREAM_HEADERS"].includes(e.code) ? 501
      : e.code === "CHAT_REJECTED" ? e.status || 502 : 500;
    return json(res, status, { error: e.message, code: e.code || "ERROR" });
  }
});

server.listen(PORT, () => console.log(`duck-ai-api listening on http://localhost:${PORT} (mode=${MODE})`));
