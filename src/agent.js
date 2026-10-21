import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const AGENT_WORKSPACE = path.resolve(process.cwd(), "agent-workspace");

export const AGENT_INSTRUCTIONS = `You are NIJHUM Agent, an autonomous task agent inside DUCK-AI-API, built by Likhon Ahmed. You complete tasks step by step using tools, then give a final answer.

TOOLS — to call a tool, reply with ONLY a block in exactly this format and nothing else:
\`\`\`tool
{"tool":"web_search","query":"your search query"}
\`\`\`

Available tools:
- web_search — {"tool":"web_search","query":"..."} — search the web, returns top results with links and snippets.
- fetch_url — {"tool":"fetch_url","url":"https://..."} — read a web page as plain text.
- run_js — {"tool":"run_js","code":"..."} — run JavaScript with Node.js inside the agent workspace, returns everything printed with console.log.
- run_python — {"tool":"run_python","code":"..."} — run Python 3 inside the agent workspace, returns printed output.
- write_file — {"tool":"write_file","path":"note.txt","content":"..."} — save a file inside the agent workspace.
- read_file — {"tool":"read_file","path":"note.txt"} — read a file from the agent workspace.
- generate_image — {"tool":"generate_image","prompt":"..."} — generate an image from a prompt.

RULES
- Call exactly one tool per reply. After you receive a tool result, decide the next step.
- Use web_search whenever the task needs current or real-world facts you do not already know. Use fetch_url to read a promising result page in full.
- Use run_js or run_python to calculate, test code, or process data instead of guessing. Print the result you need with console.log or print.
- Never invent tool results. If a tool returns an error, read it and try a different approach.
- Be efficient: you have a limited number of steps. Do not repeat a tool call that already gave you what you need.
- When the task is completely done, reply with a normal message (NO tool block): first say what you did in one or two lines, then give the final result. Put any code in fenced blocks with the language name.
- Always reply in the same language and script the user used.`;

function ensureWorkspace() {
  fs.mkdirSync(AGENT_WORKSPACE, { recursive: true });
  return AGENT_WORKSPACE;
}

function safePath(rel) {
  const base = ensureWorkspace();
  const resolved = path.resolve(base, String(rel || ""));
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("Path is outside the agent workspace");
  }
  return resolved;
}

function clip(text, max = 6000) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max) + `\n…[truncated, ${s.length - max} more chars]` : s;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

async function fetchWithTimeout(url, options = {}, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function assertPublicUrl(raw) {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http/https URLs are allowed");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host === "::1") throw new Error("Local addresses are blocked");
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error("Private network addresses are blocked");
  }
  return u;
}

async function toolWebSearch({ query }) {
  if (!query) throw new Error("web_search needs a query");
  const res = await fetchWithTimeout("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36" },
  });
  if (!res.ok) throw new Error("Search failed: HTTP " + res.status);
  const html = await res.text();
  const links = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) !== null && links.length < 6) {
    let href = decodeEntities(m[1]);
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch {} }
    links.push({ url: href, title: stripTags(m[2]) });
  }
  const snippets = [];
  const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = snipRe.exec(html)) !== null && snippets.length < 6) snippets.push(stripTags(m[1]));
  if (!links.length) return "No results found for: " + query;
  return links.map((l, i) => `${i + 1}. ${l.title}\n${l.url}${snippets[i] ? "\n" + snippets[i] : ""}`).join("\n\n");
}

async function toolFetchUrl({ url }) {
  const u = assertPublicUrl(url);
  const res = await fetchWithTimeout(u.toString(), {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36" },
  });
  if (!res.ok) throw new Error("Fetch failed: HTTP " + res.status);
  const raw = await res.text();
  if (!/html/i.test(res.headers.get("content-type") || "")) return clip(raw);
  const text = stripTags(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
  return clip(text);
}

function runProcess(file, args, ms = 12000) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: ensureWorkspace(), timeout: ms, maxBuffer: 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        let out = String(stdout || "");
        if (stderr) out += (out ? "\n" : "") + "[stderr]\n" + String(stderr);
        if (err) {
          if (err.killed || err.signal === "SIGTERM") out += (out ? "\n" : "") + `Error: timed out after ${Math.round(ms / 1000)}s`;
          else if (err.code === "ENOENT") out += (out ? "\n" : "") + `Error: ${file} not found on this system`;
          else if (!out) out = "Error: " + err.message;
        }
        resolve(clip(out || "(no output)", 4500));
      }
    );
  });
}

export async function runTool(name, args, deps = {}) {
  switch (name) {
    case "web_search":
      return toolWebSearch(args);
    case "fetch_url":
      return toolFetchUrl(args);
    case "run_js":
      if (!args.code) throw new Error("run_js needs code");
      return runProcess(process.execPath, ["-e", String(args.code)]);
    case "run_python":
      if (!args.code) throw new Error("run_python needs code");
      return runProcess("python3", ["-c", String(args.code)]);
    case "write_file": {
      if (!args.path) throw new Error("write_file needs a path");
      const target = safePath(args.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(args.content ?? ""), "utf8");
      return `Saved ${args.path} (${String(args.content ?? "").length} chars) in the agent workspace.`;
    }
    case "read_file": {
      if (!args.path) throw new Error("read_file needs a path");
      return clip(fs.readFileSync(safePath(args.path), "utf8"));
    }
    case "generate_image": {
      if (!args.prompt) throw new Error("generate_image needs a prompt");
      if (!deps.genImage) throw new Error("Image generation is not available in this mode");
      const out = await deps.genImage(String(args.prompt));
      const img = (out.images || [])[0];
      if (!img) return "Image generation returned no image. Model reply: " + (out.reply || "empty");
      return JSON.stringify({ generated: true, title: out.title || "", revised_prompt: out.revised_prompt || "", image_data: img });
    }
    default:
      throw new Error("Unknown tool: " + name);
  }
}

export function parseToolCall(text) {
  const s = String(text || "");
  const fence = s.match(/```(?:tool|json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const bare = s.match(/\{[\s\S]*?"tool"\s*:\s*"[a-z_]+"[\s\S]*?\}/);
  if (bare) candidates.push(bare[0]);
  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(cand.trim());
      if (parsed && typeof parsed.tool === "string") return parsed;
    } catch {}
  }
  return null;
}

export async function runAgent({ task, model, chatText, genImage, onEvent, isAborted, maxSteps = 8 }) {
  const messages = [
    { role: "user", content: AGENT_INSTRUCTIONS },
    { role: "assistant", content: "Bujhchi. Ami NIJHUM Agent — kaj ta daw, step by step kore dicchi." },
    { role: "user", content: task },
  ];
  let image = null;
  for (let step = 1; step <= maxSteps; step++) {
    if (isAborted && isAborted()) throw new Error("Agent stopped (client disconnected)");
    const reply = await chatText(messages, model);
    const call = parseToolCall(reply);
    if (!call) {
      if (onEvent) onEvent({ type: "final", reply, ...(image ? { image } : {}) });
      return { reply, image, steps: step - 1 };
    }
    const label = { web_search: "🔍 Search", fetch_url: "🌐 Page read", run_js: "💻 Run JS", run_python: "🐍 Run Python", write_file: "💾 Write file", read_file: "📂 Read file", generate_image: "🖼️ Image" }[call.tool] || call.tool;
    const detail = call.query || call.url || call.path || call.prompt || (call.code ? String(call.code).slice(0, 80) : "");
    if (onEvent) onEvent({ type: "step", step, tool: call.tool, label, detail: String(detail || "") });
    let result;
    try {
      result = await runTool(call.tool, call, { genImage: genImage ? (prompt) => genImage(prompt, model) : null });
    } catch (e) {
      result = "Tool error: " + e.message;
    }
    let resultForModel = result;
    if (call.tool === "generate_image") {
      try {
        const parsed = JSON.parse(result);
        if (parsed && parsed.image_data) {
          image = { src: parsed.image_data, title: parsed.title || "", revised_prompt: parsed.revised_prompt || "" };
          resultForModel = `Image generated successfully. Title: "${parsed.title || ""}". The user can already see the image in the chat, do not paste the image data.`;
          if (onEvent) onEvent({ type: "image", step, image });
        }
      } catch {}
    }
    if (onEvent) onEvent({ type: "result", step, tool: call.tool, summary: clip(resultForModel, 220) });
    messages.push({ role: "assistant", content: reply });
    messages.push({ role: "user", content: `Tool result (${call.tool}):\n${clip(resultForModel, 6000)}\n\nContinue with the next step, or if the task is fully done, give the final answer now without any tool block.` });
  }
  const reply = "Agent step limit (" + maxSteps + ") shesh hoye geche — kaj ta puropuri sesh korte parini. Task ta chhoto kore vag kore abar daw.";
  if (onEvent) onEvent({ type: "final", reply, ...(image ? { image } : {}) });
  return { reply, image, steps: maxSteps };
}
