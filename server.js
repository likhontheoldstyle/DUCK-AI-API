import http from "node:http";
import { KNOWN_MODELS, sendUpstream } from "./src/duckClient.js";
import { chatViaBrowser } from "./src/browserClient.js";

const PORT = Number(process.env.PORT || 3000);
const MODE = process.env.DUCK_MODE || "mock"; // mock | browser | upstream

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

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true, mode: MODE, models: KNOWN_MODELS.map((m) => m.id),
        usage: 'POST /chat {"message":"hi","model":"Luna"}' });
    }
    if (req.method === "GET" && req.url === "/models") return json(res, 200, { models: KNOWN_MODELS });
    if (req.method === "GET" && req.url === "/capture") return json(res, 200, CAPTURED);

    if (req.method === "POST" && req.url === "/chat") {
      const body = await readBody(req);
      const message = body.message || body.messages?.at(-1)?.content;
      if (!message) return json(res, 400, { error: 'Send {"message":"hi"} or {"messages":[...]}' });
      const model = body.model || process.env.DUCK_MODEL || "Luna";

      if (MODE === "browser") {
        // REAL path: uses the duck.ai model (default Luna) through its web UI.
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
    return json(res, 404, { error: "Not found. Try GET /health, GET /models, POST /chat" });
  } catch (e) {
    const status = e.code === "PLAYWRIGHT_MISSING" || e.code === "MISSING_UPSTREAM_HEADERS" ? 501 : 500;
    return json(res, status, { error: e.message, code: e.code || "ERROR" });
  }
});

server.listen(PORT, () => console.log(`duck-ai-api listening on http://localhost:${PORT} (mode=${MODE})`));
