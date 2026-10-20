import http from "node:http";
import { KNOWN_MODELS, sendUpstream } from "./src/duckClient.js";
import { chatViaBrowser } from "./src/browserClient.js";
import { chatViaScrape, scrapeVersions, getChallenge, newJourneyId, getTransport, MODEL_IDS, PROFILE } from "./src/scrapeClient.js";

const PORT = Number(process.env.PORT || 3000);
const MODE = process.env.DUCK_MODE || "scrape"; // scrape (default) | mock | browser | upstream

const CAPTURED = { model: "Luna", message: "hi", response: "Hi! How can I help?" };

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
<button id="send">Send</button></p>
<p style="color:#555">API endpoints: GET /health &nbsp; GET /models &nbsp; GET /scrape-status &nbsp; POST /chat</p>
<script>
const log=document.getElementById('log');
async function send(){
  const message=document.getElementById('msg').value.trim(); if(!message) return;
  const model=document.getElementById('model').value;
  log.textContent += 'You: '+message+'\\nWaiting...\\n';
  try{
    const r=await fetch('/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message,model})});
    const j=await r.json();
    log.textContent += (j.reply?('AI ('+(j.model||model)+'): '+j.reply):('Error '+r.status+': '+(j.error||JSON.stringify(j))))+'\\n\\n';
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
        const out = await chatViaScrape({ message, messages: body.messages, model });
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
    return json(res, 404, { error: "Not found. Try GET /health, GET /models, GET /scrape-status, POST /chat" });
  } catch (e) {
    const status = ["PLAYWRIGHT_MISSING", "JSDOM_MISSING", "MISSING_UPSTREAM_HEADERS"].includes(e.code) ? 501
      : e.code === "CHAT_REJECTED" ? e.status || 502 : 500;
    return json(res, status, { error: e.message, code: e.code || "ERROR" });
  }
});

server.listen(PORT, () => console.log(`duck-ai-api listening on http://localhost:${PORT} (mode=${MODE})`));
