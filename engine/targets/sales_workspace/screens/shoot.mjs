// Throwaway screenshot script (1920x1080) for reviewing the workspace's design.
// Usage, from the project root, with the app running on a database loaded with tests/fixture.sql:
//   BASE_URL=http://127.0.0.1:8097 SW_PASSWORD=<TEST_PASSWORD from tests/conftest.py> node engine/targets/sales_workspace/screens/shoot.mjs [step ...]
// Steps run in order and change data (two blocked "Closed Won" moves), so use a fresh database for a full run.
import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || "http://127.0.0.1:8097";
const PASSWORD = process.env.SW_PASSWORD;
if (!PASSWORD) throw new Error("Set SW_PASSWORD to the fixture's test password.");
const wanted = new Set(process.argv.slice(2));

// Like the project's playwright.config.ts: the installed Google Chrome by default (PW_CHANNEL= for Playwright's Chromium).
const channel = process.env.PW_CHANNEL ?? "chrome";
const browser = await chromium.launch(channel ? { channel } : {});

async function session(user) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: "light" });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("page error:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.error("console:", msg.text()); });
  if (user) {
    await page.goto(BASE + "/login");
    await page.fill("#user_name", user);
    await page.fill("#password", PASSWORD);
    await Promise.all([page.waitForURL((url) => !url.pathname.startsWith("/login")), page.click('button[type="submit"]')]);
  }
  return { context, page };
}

async function shot(page, name, fullPage = false) {
  await page.waitForLoadState("networkidle");
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(here, `${name}.png`), fullPage });
  console.log("saved", `${name}.png`);
}

const steps = [
  ["login", async () => {
    const { page, context } = await session(null);
    await page.goto(BASE + "/login");
    await shot(page, "01-login");
    await context.close();
  }],
  ["home", async () => {
    let { page, context } = await session("pnair");
    await shot(page, "02-home-salesperson");
    await context.close();
    ({ page, context } = await session("mchen"));
    await shot(page, "03-home-manager");
    await context.close();
  }],
  ["accounts", async () => {
    const { page, context } = await session("pnair");
    await page.goto(BASE + "/accounts");
    await shot(page, "04-accounts");
    await context.close();
  }],
  ["account", async () => {
    const { page, context } = await session("pnair");
    await page.goto(BASE + "/accounts/acc-acme-supply");
    await shot(page, "05-account");
    await shot(page, "05-account-full", true);
    await context.close();
  }],
  ["pipeline", async () => {
    const { page, context } = await session("pnair");
    await page.goto(BASE + "/pipeline");
    await shot(page, "06-pipeline");
    await context.close();
  }],
  ["pipeline-blocked", async () => {
    const { page, context } = await session("pnair");
    await page.goto(BASE + "/pipeline");
    const card = page.locator('.deal-card[data-deal-id="d-acme-shelving"]');
    await card.locator("details.move summary").click();
    await card.locator('select[name="stage"]').selectOption("Closed Won");
    await card.locator('button[type="submit"]').click();
    await page.waitForSelector("#page-rule .rule-banner");
    await page.waitForTimeout(700);
    await shot(page, "07-pipeline-blocked");
    await context.close();
  }],
  ["deal-blocked", async () => {
    const { page, context } = await session("pnair");
    await page.goto(BASE + "/deals/d-acme-25001");
    await page.selectOption("#stage-select", "Closed Won");
    await Promise.all([page.waitForNavigation(), page.click('.stage-control button[type="submit"]')]);
    await page.waitForSelector(".rule-banner");
    await page.waitForTimeout(700);
    await shot(page, "08-deal-blocked");
    await context.close();
  }],
  ["approvals", async () => {
    const { page, context } = await session("mchen");
    await page.goto(BASE + "/approvals");
    await shot(page, "09-approvals");
    await context.close();
  }],
  ["convert", async () => {
    const { page, context } = await session("pnair");
    await page.goto(BASE + "/leads/l-ethan-brooks/convert");
    await shot(page, "10-lead-convert");
    await shot(page, "10-lead-convert-full", true);
    await context.close();
  }],
  ["extra", async () => {
    const { page, context } = await session("pnair");
    for (const [path, name] of [["/search?q=acme", "x-search"], ["/contacts/c-maria-lopez", "x-contact"],
      ["/leads/l-ethan-brooks", "x-lead"], ["/leads", "x-leads"], ["/deals", "x-deals"], ["/contacts", "x-contacts"],
      ["/deals/new?account_id=acc-acme-supply", "x-deal-form"], ["/accounts/acc-acme-supply-co", "x-404"]]) {
      await page.goto(BASE + path);
      await shot(page, name);
    }
    await page.goto(BASE + "/leads/l-olivia-grant/convert");
    await page.check('input[name="create_deal"]');
    await page.fill("#deal_amount", "18500");
    await shot(page, "x-convert-new-with-deal");
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"].btn-primary')]);
    await shot(page, "x-converted");
    await page.goto(BASE + "/leads/l-olivia-grant/convert");
    await shot(page, "x-already-converted");
    await context.close();
    const admin = await session("dkim");
    await shot(admin.page, "x-home-support");
    await admin.context.close();
  }],
];

for (const [name, run] of steps) {
  if (wanted.size && !wanted.has(name)) continue;
  await run();
}
await browser.close();
