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

  const proxyOpt = {};
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY;
  if (proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      proxyOpt.proxy = { server: `${u.protocol}//${u.host}` };
      if (u.username) proxyOpt.proxy.username = decodeURIComponent(u.username);
      if (u.password) proxyOpt.proxy.password = decodeURIComponent(u.password);
    } catch {  }
  }
  ctx = await chromium.launchPersistentContext("./.duck-profile", {
    headless: process.env.HEADLESS !== "false",
    viewport: { width: 1280, height: 900 },
    ...proxyOpt,
  });
  page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://duck.ai/", { waitUntil: "domcontentloaded", timeout: 60_000 });

  const cont = page.getByRole("button", { name: /continue/i }).first();
  if (await cont.isVisible().catch(() => false)) {
    await cont.click().catch(() => {});
  }
  return page;
}

async function selectModel(p, model) {
  if (!model) return;

  try {
    const control = p.getByText(/model/i).first();
    await control.click({ timeout: 3_000 });
    const option = p.getByText(new RegExp(model, "i")).first();
    await option.click({ timeout: 3_000 });
  } catch {  }
}

async function doChat({ message, model }) {
  const p = await ensurePage();
  if (!/duck\.ai/.test(p.url())) {
    await p.goto("https://duck.ai/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  await selectModel(p, model);

  const box = p.locator(
    'textarea, [contenteditable="true"], input[type="text"]'
  ).filter({ hasNotText: "" }).last();
  await box.waitFor({ timeout: 30_000 });
  await box.click();
  await box.fill(message).catch(async () => { await p.keyboard.type(message); });

  const ask = p.getByRole("button", { name: /ask|send/i }).first();
  if (await ask.isVisible().catch(() => false)) await ask.click().catch(() => {});
  else await p.keyboard.press("Enter");

  let last = "", stableSince = Date.now();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await p.waitForTimeout(800);
    const text = await p.locator("body").innerText();
    if (text.includes("Generating response")) { last = text; stableSince = Date.now(); continue; }
    if (text !== last) { last = text; stableSince = Date.now(); }
    else if (Date.now() - stableSince > 2_000) break;
  }

  const bodyText = await p.locator("body").innerText();
  const idx = bodyText.lastIndexOf(message);
  const tail = (idx >= 0 ? bodyText.slice(idx + message.length) : bodyText).trim();
  return { model: model || "Luna", reply: tail, raw: bodyText };
}

export function chatViaBrowser(args) {

  const run = queue.then(() => doChat(args), () => doChat(args));
  queue = run.catch(() => {});
  return run;
}
