// Browser-automation backend for duck.ai
//
// Why browser automation, not token capture?
// - duck.ai has no official API key. The web page itself is the supported client.
// - This client uses the page exactly as a person does: open duck.ai,
//   accept the privacy gate, pick the model, type in the chat box, read the reply.
// - It does NOT extract cookies / x-vqd tokens, and does NOT solve or forge
//   the site's anti-abuse challenge outside the browser. The browser does
//   its normal work, which is why the tokens stay inside the browser.
//
// Limits: one browser = one chat at a time (requests are queued),
// the page UI can change and selectors may need updating, and you are
// responsible for using it within DuckDuckGo's Terms for your own use.
//
// Setup:
//   npm install playwright
//   npx playwright install chromium

let queue = Promise.resolve();
let ctx = null;
let page = null;

async function ensurePage() {
  if (page && !page.isClosed()) return page;
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    const err = new Error(
      "Playwright is not installed. Run: npm install playwright && npx playwright install chromium"
    );
    err.code = "PLAYWRIGHT_MISSING";
    throw err;
  }
  // Respect a proxy from the environment (e.g. on this VM all egress goes
  // through HTTPS_PROXY). Credentials, if any, come from the env var itself
  // at runtime - they are never written into this code or the repo.
  const proxyOpt = {};
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY;
  if (proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      proxyOpt.proxy = { server: `${u.protocol}//${u.host}` };
      if (u.username) proxyOpt.proxy.username = decodeURIComponent(u.username);
      if (u.password) proxyOpt.proxy.password = decodeURIComponent(u.password);
    } catch { /* ignore malformed proxy env */ }
  }
  ctx = await chromium.launchPersistentContext("./.duck-profile", {
    headless: process.env.HEADLESS !== "false",
    viewport: { width: 1280, height: 900 },
    ...proxyOpt,
  });
  page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://duck.ai/", { waitUntil: "domcontentloaded", timeout: 60_000 });

  // Privacy gate seen in the captured session: "Continue" button
  const cont = page.getByRole("button", { name: /continue/i }).first();
  if (await cont.isVisible().catch(() => false)) {
    await cont.click().catch(() => {});
  }
  return page;
}

async function selectModel(p, model) {
  if (!model) return;
  // Model control is labelled "Model" on the page (observed in capture).
  // Best-effort, text-based selection; harmless if the model is already active
  // (Luna was the default in the captured session).
  try {
    const control = p.getByText(/model/i).first();
    await control.click({ timeout: 3_000 });
    const option = p.getByText(new RegExp(model, "i")).first();
    await option.click({ timeout: 3_000 });
  } catch { /* already selected / UI changed - continue with default */ }
}

async function doChat({ message, model }) {
  const p = await ensurePage();
  if (!/duck\.ai/.test(p.url())) {
    await p.goto("https://duck.ai/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  await selectModel(p, model);

  // Chat box: first visit placeholder is "Ask anything privately",
  // in an open chat it is "Reply..." (both observed in the capture).
  const box = p.locator(
    'textarea, [contenteditable="true"], input[type="text"]'
  ).filter({ hasNotText: "" }).last();
  await box.waitFor({ timeout: 30_000 });
  await box.click();
  await box.fill(message).catch(async () => { await p.keyboard.type(message); });

  const ask = p.getByRole("button", { name: /ask|send/i }).first();
  if (await ask.isVisible().catch(() => false)) await ask.click().catch(() => {});
  else await p.keyboard.press("Enter");

  // Wait until generation finishes: poll the page text until it is stable
  // for ~2s after the "Generating response" indicator disappears.
  let last = "", stableSince = Date.now();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await p.waitForTimeout(800);
    const text = await p.locator("body").innerText();
    if (text.includes("Generating response")) { last = text; stableSince = Date.now(); continue; }
    if (text !== last) { last = text; stableSince = Date.now(); }
    else if (Date.now() - stableSince > 2_000) break;
  }

  // The reply is the text that appeared after the user's own message.
  // Return the full visible tail as a best effort; callers also get `pageTextTail`
  // in debug mode. UI changes are the main maintenance risk here.
  const bodyText = await p.locator("body").innerText();
  const idx = bodyText.lastIndexOf(message);
  const tail = (idx >= 0 ? bodyText.slice(idx + message.length) : bodyText).trim();
  return { model: model || "Luna", reply: tail, raw: bodyText };
}

export function chatViaBrowser(args) {
  // Serialize: a single browser session handles one message at a time.
  const run = queue.then(() => doChat(args), () => doChat(args));
  queue = run.catch(() => {});
  return run;
}
