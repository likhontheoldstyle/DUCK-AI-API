import http from "node:http";
import { KNOWN_MODELS, sendUpstream } from "./src/duckClient.js";
import { chatViaBrowser } from "./src/browserClient.js";
import { chatViaScrape, scrapeVersions, getChallenge, newJourneyId, getTransport, MODEL_IDS, PROFILE, getLastRaw } from "./src/scrapeClient.js";

const PORT = Number(process.env.PORT || 3000);
const MODE = process.env.DUCK_MODE || "scrape";

const CAPTURED = { model: "Luna", message: "hi", response: "Hi! How can I help?" };

const MIN_INTERVAL_MS = Number(process.env.DUCK_MIN_INTERVAL_MS || 3000);
const CACHE_TTL_MS = Number(process.env.DUCK_CACHE_TTL_MS || 600_000);
const WAIT_429_MS = Number(process.env.DUCK_429_WAIT_MS || 60_000);
const _cache = new Map();
let _queue = Promise.resolve();
let _lastCallAt = 0;
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let LAST_IMAGE = null;
function rememberImage(out) {
  const img = (out?.images || [])[0];
  if (typeof img === "string" && img.startsWith("data:")) {
    const comma = img.indexOf(",");
    LAST_IMAGE = {
      mime: img.slice(5, img.indexOf(";")) || "image/jpeg",
      buf: Buffer.from(img.slice(comma + 1), "base64"),
    };
  }
}

function enqueueScrape(args) {
  const imgTag = args.imageData ? ":" + args.imageData.length + ":" + args.imageData.slice(-24) : "";
  const key = JSON.stringify([args.model, args.image ? 1 : 0, (args.messages || args.message) + imgTag]);
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
    req.on("data", (c) => { raw += c; if (raw.length > 16 * 1024 * 1024) req.destroy(); });
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

const EDIT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Image Edit</title><style>body{font-family:system-ui;max-width:720px;margin:24px auto;padding:0 14px}input,textarea,button{width:100%;margin:8px 0;padding:10px;box-sizing:border-box}img{max-width:100%;border-radius:10px}</style></head>
<body><h2>Edit an image</h2>
<input type="file" id="f" accept="image/*">
<textarea id="p" rows="3" placeholder="Describe the edit, e.g. make it a cartoon style"></textarea>
<button id="b">Edit image</button>
<p id="s"></p><img id="out"><p id="t" style="color:#555"></p>
<script>
const $=id=>document.getElementById(id);
$('b').onclick=async()=>{
  const file=$('f').files[0]; if(!file){$('s').textContent='Pick a photo first';return;}
  if(!$('p').value.trim()){$('s').textContent='Write what edit you want';return;}
  $('s').textContent='Working... this can take up to a minute';
  const bmp=await createImageBitmap(file);
  const scale=Math.min(1,1024/Math.max(bmp.width,bmp.height));
  const cv=document.createElement('canvas');cv.width=Math.round(bmp.width*scale);cv.height=Math.round(bmp.height*scale);
  cv.getContext('2d').drawImage(bmp,0,0,cv.width,cv.height);
  const dataUrl=cv.toDataURL('image/png');
  try{
    const res=await fetch('/image-edit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({image:dataUrl,prompt:$('p').value,model:'Luna'})});
    const j=await res.json();
    if(j.images&&j.images.length){$('out').src=j.images[0];$('t').textContent=(j.title||'')+' - '+(j.revised_prompt||'');$('s').textContent='Done. Long-press the image to save it.';}
    else{$('s').textContent='No image returned: '+JSON.stringify(j).slice(0,300);}
  }catch(e){$('s').textContent='Error: '+e.message;}
};
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
    if (req.method === "GET" && req.url === "/debug-last") {
      const raw = getLastRaw();
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      if (!raw) return res.end("no request yet");
      return res.end(`at=${raw.at} model=${raw.model} image=${raw.image} variant=${raw.variant} bytes=${raw.text.length}\n\n${raw.text.slice(0, 60000)}`);
    }
    if (req.method === "GET" && req.url === "/scrape-status") {

      const fe = await scrapeVersions();
      const ch = await getChallenge(fe, newJourneyId());
      const transport = (await getTransport()).kind;
      return json(res, 200, { transport, deviceProfile: PROFILE.name, userAgent: PROFILE.ua, phase1: fe, phase2: { statusBody: ch.statusBody, jsaLength: ch.jsa.length, jsaPrefix: ch.jsa.slice(0, 24) + "…" } });
    }

    if (req.method === "GET" && (req.url.startsWith("/chat?") || req.url.startsWith("/image?"))) {
      const u = new URL(req.url, "http://localhost");
      const model = u.searchParams.get("model") || process.env.DUCK_MODEL || "Luna";
      const isImage = req.url.startsWith("/image");
      const text = u.searchParams.get(isImage ? "prompt" : "message") || u.searchParams.get("q") || "";
      if (!text) {
        return json(res, 400, { error: isImage ? "Use /image?prompt=a+cat+in+space" : "Use /chat?message=hi&model=Luna" });
      }
      if (MODE !== "scrape") {
        const reply = text.trim().toLowerCase() === "hi" ? CAPTURED.response : `[mock:${model}] You said: ${text}`;
        return json(res, 200, { model, reply, mode: MODE });
      }
      const out = await enqueueScrape({ message: text, model, image: isImage });
      if (isImage) rememberImage(out);
      if (isImage) return json(res, 200, { model: out.model, prompt: text, images: out.images || [], title: out.title || undefined, revised_prompt: out.revised_prompt || undefined, reply: out.reply, debug: out.debug });
      return json(res, 200, { model: out.model, reply: out.reply, variant: out.variant });
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
      rememberImage(out);
      return json(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data: (out.images || []).map((img) => img.startsWith("data:")
          ? { b64_json: img.split(",", 2)[1], revised_prompt: out.revised_prompt || undefined }
          : { url: img, revised_prompt: out.revised_prompt || undefined }),
      });
    }

    if (req.method === "GET" && req.url === "/last-image") {
      if (!LAST_IMAGE) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("No image generated yet. Use /image-view?prompt=... first."); }
      res.writeHead(200, { "content-type": LAST_IMAGE.mime, "cache-control": "no-store" });
      return res.end(LAST_IMAGE.buf);
    }

    if (req.method === "GET" && req.url.startsWith("/image-view")) {
      const u = new URL(req.url, "http://localhost");
      const prompt = u.searchParams.get("prompt") || u.searchParams.get("q") || "";
      const model = u.searchParams.get("model") || "Luna";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (!prompt) return res.end("<h3>Use: /image-view?prompt=a+cat+in+space</h3>");
      if (MODE !== "scrape") return res.end("<h3>Image view needs DUCK_MODE=scrape</h3>");
      try {
        const out = await enqueueScrape({ message: prompt, model, image: true });
        rememberImage(out);
        const img = (out.images || [])[0];
        if (!img) return res.end(`<h3>No image came back.</h3><pre>${JSON.stringify(out, null, 2).slice(0, 1000)}</pre>`);
        return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${out.title || prompt}</title><body style="font-family:system-ui;max-width:760px;margin:20px auto;padding:0 12px">
<h3>${out.title || ""}</h3><p style="color:#555">${prompt}</p>
<img src="${img}" style="max-width:100%;border-radius:10px">
<p style="color:#555">${out.revised_prompt || ""}</p>
<p><a href="/last-image">Open raw image</a> (long-press to save)</p></body>`);
      } catch (e) {
        return res.end(`<h3>Error</h3><pre>${e.message}</pre>`);
      }
    }

    if (req.method === "POST" && req.url === "/image-edit") {
      const body = await readBody(req);
      if (!body.image) return json(res, 400, { error: "missing 'image' (base64 or data URI)" });
      if (!body.prompt) return json(res, 400, { error: "missing 'prompt' (what edit to make)" });
      if (MODE === "mock") return json(res, 200, { model: body.model || "Luna", images: [], mode: "mock" });
      if (MODE !== "scrape") return json(res, 400, { error: "image edit requires DUCK_MODE=scrape" });
      const out = await enqueueScrape({ message: body.prompt, model: body.model || "Luna", image: true, imageData: body.image, imageMime: body.mime });
      rememberImage(out);
      return json(res, 200, { model: out.model, prompt: body.prompt, images: out.images || [], title: out.title || undefined, revised_prompt: out.revised_prompt || undefined, reply: out.reply, mode: "scrape", variant: out.variant, debug: out.debug });
    }

    if (req.method === "GET" && (req.url === "/edit" || req.url.startsWith("/edit?"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(EDIT_PAGE);
    }

    if (req.method === "POST" && req.url === "/image") {      const body = await readBody(req);
      const prompt = body.prompt || body.message;
      if (!prompt) return json(res, 400, { error: 'Send {"prompt":"a cat in space"}' });
      const model = body.model || process.env.DUCK_MODEL || "Luna";
      if (MODE !== "scrape") return json(res, 400, { error: "Image generation needs DUCK_MODE=scrape" });
      const out = await enqueueScrape({ message: prompt, model, image: true });
      rememberImage(out);
      return json(res, 200, { model: out.model, prompt, images: out.images || [], title: out.title || undefined, revised_prompt: out.revised_prompt || undefined, reply: out.reply, mode: "scrape", variant: out.variant, debug: out.debug });
    }
    return json(res, 404, { error: "Not found. Try GET /health, GET /models, GET /scrape-status, POST /chat, POST /image" });
  } catch (e) {
    const status = ["PLAYWRIGHT_MISSING", "JSDOM_MISSING", "MISSING_UPSTREAM_HEADERS"].includes(e.code) ? 501
      : e.code === "CHAT_REJECTED" ? e.status || 502 : 500;
    return json(res, status, { error: e.message, code: e.code || "ERROR" });
  }
});

server.listen(PORT, () => console.log(`duck-ai-api listening on http://localhost:${PORT} (mode=${MODE})`));
