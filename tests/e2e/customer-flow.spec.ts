import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// The sample Django booking site from the engine's test fixtures, zipped as a customer would upload it.
const CLINIC = path.resolve("engine/tests/fixtures/samples/django-clinic");
function clinicZip() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2e-")), "clinic.zip");
  execFileSync("/usr/bin/zip", ["-r", "-q", out, ".", "-x", "*.db", "-x", "__pycache__/*", "-x", "*.pyc"], { cwd: path.join(CLINIC, "repo") });
  return out;
}

async function signIn(page: Page, destination = "/ops") {
  await page.goto(destination);
  if (page.url().includes("/ops/login")) {
    const fileToken = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8").split("\n").find(line => line.startsWith("GOOSE_OPERATOR_TOKEN="))?.slice("GOOSE_OPERATOR_TOKEN=".length).trim() : undefined;
    const token = process.env.GOOSE_OPERATOR_TOKEN || fileToken;
    expect(token, "An operator key must be configured for the authenticated operator test").toBeTruthy();
    await page.getByLabel("Operator key").fill(token!);
    await page.getByRole("button", { name: /Sign in/ }).click();
    await expect(page).not.toHaveURL(/\/ops\/login/);
    if (!page.url().endsWith(destination)) await page.goto(destination);
  }
}

test("landing page states the promise, shows example migrations, and starts a job from an example", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Migrations that land/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /An AI team that upgrades your software/i })).toBeVisible();
  await expect(page.locator(".ex")).toHaveCount(4);
  await expect(page.getByText("These are only examples.", { exact: false })).toBeVisible();
  await page.locator(".ex", { hasText: "ROS 2" }).getByRole("link", { name: /Start with this/ }).click();
  await expect(page).toHaveURL(/\/start\?example=ros/);
  await expect(page.getByLabel("Migrating to")).toHaveValue("ROS 2");
  await expect(page.getByLabel("GitHub repository")).toBeVisible();
});

test("a customer completes assessment, verified delivery, test payment, support, monitoring and follow-up work", async ({ page, context }) => {
  await page.goto("/start");
  await page.getByLabel("Business name").fill("Sample Clinic (test)");
  await page.getByLabel("Application name").fill("Sample Clinic booking site");
  await page.getByLabel("Your name").fill("Playwright Tester");
  await page.getByLabel("Email").fill("tester@example.com");
  await page.getByLabel(/Business time zone/).selectOption("America/New_York");
  await page.getByLabel(/Your goal/).fill("Bring our booking site onto a supported Django version. The pages, the reception kiosk feed and " +
    "the reminder script must keep working exactly as today.");
  for (const c of ["keep_database", "keep_api", "keep_connections"]) await page.locator(`input[name=constraints][value=${c}]`).check();
  await page.getByRole("button", { name: "Upload a .zip instead" }).click();   // the sample isn't on GitHub
  await page.getByLabel("Type of engineering work").selectOption("service");
  await page.locator("input[name=repository]").setInputFiles(clinicZip());
  await page.locator("input[name=database]").setInputFiles(path.join(CLINIC, "data", "clinic.db"));
  await page.locator("input[name=demo]").check();
  await page.locator("input[name=authorized]").check();
  await page.getByRole("button", { name: "Begin migration" }).click();
  await expect(page).toHaveURL(/\/jobs\/GS-\d+\?t=/);
  await expect(page.getByText("Demo · synthetic data")).toBeVisible();
  await expect(page.getByText("Your goal", { exact: true })).toBeVisible();
  // the plan comes from inspecting this application: Django is kept and upgraded, the database is kept
  await expect(page.getByRole("heading", { name: /Proposal v1/ })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/Upgrade to Django 5.2 LTS/).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Options we considered" })).toBeVisible();
  // the application map shows what a component does and what the plan does to it
  await page.getByRole("button", { name: /GET \/api\/slots\.json/ }).click();
  await expect(page.getByText("The plan keeps it")).toBeVisible();
  await page.getByLabel("Your name").fill("Playwright Tester");
  await page.getByRole("button", { name: "Accept proposal" }).locator("..").locator("..").getByRole("checkbox").check();
  await page.getByRole("button", { name: "Accept proposal" }).click();
  // record, freeze, change, verify - then the delivery appears
  await expect(page.getByRole("heading", { name: "Delivery", exact: true })).toBeVisible({ timeout: 6 * 60_000 });
  await expect(page.getByText("All mandatory checks passed").first()).toBeVisible();
  await expect(page.getByText(/Before and after/)).toBeVisible();
  const delivery = page.locator("section").filter({ has: page.getByRole("heading", { name: "Delivery", exact: true }) });
  const downloadPromise = page.waitForEvent("download");
  await delivery.getByRole("link", { name: "Download the package" }).click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  expect(downloadedPath).toBeTruthy();
  const archive = fs.readFileSync(downloadedPath!);
  expect(archive.subarray(0, 2).toString()).toBe("PK");
  const expectedDigest = (await delivery.getByText(/^SHA-256 /).textContent())!.replace("SHA-256 ", "").trim();
  expect(createHash("sha256").update(archive).digest("hex")).toBe(expectedDigest);
  const artifactUrl = new URL((await delivery.getByRole("link", { name: "Download the package" }).getAttribute("href"))!, page.url());
  artifactUrl.search = "";
  expect((await page.request.get(artifactUrl.toString())).status()).toBe(404);
  artifactUrl.search = "?ops=1";
  expect((await page.request.get(artifactUrl.toString())).status()).toBe(401);
  const privateJobId = new URL(page.url()).pathname.split("/").pop()!;
  expect((await page.request.get(`/api/jobs/${privateJobId}/source?ops=1&path=clinic%2Fsettings.py`)).status()).toBe(401);
  expect((await page.request.get(`/jobs/${privateJobId}/result?ops=1`)).status()).toBe(404);
  const origin = new URL(page.url()).origin;
  expect((await page.request.post(`/api/jobs/${privateJobId}/preview?ops=1`, { headers: { Origin: origin }, data: { action: "start" } })).status()).toBe(401);
  expect((await page.request.post(`/api/try/${privateJobId}?ops=1`, { headers: { Origin: origin }, data: { method: "GET", path: "/" } })).status()).toBe(401);
  await page.getByLabel("Your name").fill("Playwright Tester");
  await page.getByRole("button", { name: "Accept the delivery" }).locator("..").locator("..").getByRole("checkbox").check();
  await page.getByRole("button", { name: "Accept the delivery" }).click();
  await expect(page.getByRole("heading", { name: /Invoice TEST-GS-INV-/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Test invoice - not sent, nothing owed")).toBeVisible();
  const customerUrl = page.url();
  const jobId = new URL(customerUrl).pathname.split("/").pop()!;
  await page.getByRole("button", { name: "Prepare test checkout" }).click();
  await expect(page.getByText("Test checkout is ready. Use Complete test checkout to record a simulated payment.")).toBeVisible();
  await page.getByRole("button", { name: "Complete test checkout" }).click();
  await expect(page.getByText("Test payment recorded. No real money moved.")).toBeVisible();
  await page.getByLabel("Check frequency").selectOption("7");
  await page.getByRole("checkbox", { name: /I agree to these recurring integrity checks/ }).check();
  await page.getByRole("button", { name: "Enable monitoring" }).click();
  await expect(page.getByText("Plan active", { exact: true })).toBeVisible();

  const subject = `Follow-up request for ${jobId}`;
  await page.getByLabel("Support subject").fill(subject);
  await page.getByLabel("Details", { exact: true }).fill("Please assess a separate update to our reminder integration and preserve the booking API.");
  await page.getByRole("checkbox", { name: /This requests a new engineering change/ }).check();
  await page.getByRole("button", { name: "Submit support request" }).click();
  await expect(page.getByRole("heading", { name: "Follow-up engineering" })).toBeVisible();
  await expect(page.getByLabel(/Fresh source/)).toBeVisible();

  const ops = await context.newPage();
  await signIn(ops, "/ops/business");
  await expect(ops.getByRole("heading", { name: "Customer operations" })).toBeVisible();
  // Use the job's invoice row, independent of invoice numbering and other test jobs.
  const invoiceRow = ops.locator("tbody tr").filter({ has: ops.getByRole("link", { name: jobId, exact: true }) }).filter({ hasText: "TEST-GS-INV-" });
  await expect(invoiceRow).toContainText("paid");
  const ticket = ops.locator("article").filter({ has: ops.getByText(subject, { exact: true }) });
  await ticket.getByRole("textbox", { name: /Resolution for ticket/ }).fill("The follow-up is separately scoped. Upload fresh source in the customer workspace to start its assessment.");
  await ticket.getByRole("button", { name: "Resolve ticket" }).click();
  await expect(ticket).toContainText("resolved");
  await ops.getByRole("button", { name: "Process due checks" }).click();
  await expect(ops.getByText("Due maintenance checks processed. Review their outcomes below.")).toBeVisible();
  await ops.getByRole("checkbox", { name: "Enable routine customer updates under this policy." }).check();
  await ops.getByRole("checkbox", { name: /Authorize real email delivery to linked customers/ }).uncheck();
  await ops.getByRole("button", { name: "Save communication policy" }).click();
  await expect(ops.getByText("Transactional communication policy saved.")).toBeVisible();
  await ops.getByRole("button", { name: "Process customer events" }).click();
  await expect(ops.getByText("Customer events processed. Review the outbox and support records.")).toBeVisible();

  await ops.getByLabel("Recipient email").fill("tester@example.com");
  await ops.getByLabel("Subject", { exact: true }).fill(`Test delivery note ${jobId}`);
  await ops.getByLabel("Message", { exact: true }).fill("This is a synthetic browser test of the exact-message authorization flow. No external delivery is requested.");
  await ops.getByLabel("Related job ID (optional)").fill(jobId);
  await ops.getByRole("checkbox", { name: "Test message", exact: true }).check();
  await ops.getByRole("button", { name: "Save draft" }).click();
  const email = ops.locator("article").filter({ has: ops.getByText(`Test delivery note ${jobId}`, { exact: true }) });
  await expect(email).toContainText("draft");
  ops.once("dialog", dialog => dialog.accept());
  await email.getByRole("button", { name: "Authorize test send" }).click();
  await expect(email).toContainText("sent");
  await expect(email.getByRole("button", { name: "Authorize test send" })).toHaveCount(0);
  await ops.close();

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("Plan paused", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: /I agree to these recurring integrity checks/ }).check();
  await page.getByRole("button", { name: "Resume monitoring" }).click();
  await expect(page.getByText("Plan active", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Plan cancelled", { exact: true })).toBeVisible();
  await page.getByLabel(/Fresh source/).setInputFiles(clinicZip());
  await page.getByLabel("Current data snapshot (optional)").setInputFiles(path.join(CLINIC, "data", "clinic.db"));
  await page.getByRole("button", { name: "Start follow-up assessment" }).click();
  await expect(page).toHaveURL(/\/jobs\/GS-\d+\?t=/);
  await expect(page).not.toHaveURL(customerUrl);
  await expect(page.getByText("Demo · synthetic data")).toBeVisible();
  const childJobId = new URL(page.url()).pathname.split("/").pop()!;
  await page.goto(customerUrl);
  await expect(page.getByRole("link", { name: `Open follow-up ${childJobId} ↗` })).toBeVisible();
});

test("the operator view shows the job, its responsible agent and its spend", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Operator" })).toBeVisible();
  await expect(page.getByText("Local mode - no AI", { exact: true })).toBeVisible();
  const first = page.locator("tbody tr").first();
  await expect(first).toContainText("GS-");
  await first.getByRole("link").first().click();
  await expect(page.getByRole("heading", { name: "Customer approvals" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Founder interventions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Spending" })).toBeVisible();
});

test("incoming email receipts preserve exact text and display original HTML without executing it", async ({ page }) => {
  await signIn(page, "/ops/business");
  const plain = "Hello Goose,\n\nPlease preserve  this spacing.\n<script>window.__gooseInjected=true</script>\n";
  const html = '<p>Original email</p><img src="https://goose-test.invalid/tracker" onerror="window.__gooseInjected=true">';
  const fixture = { id: 881177, event_type: "message.received", sender: "Synthetic sender <receipt@example.test>", subject: "Browser fixture: original inbound content", is_test: true, outcome: "needs_review", reason: "Synthetic receipt for UI rendering verification", inquiry_id: null, received_at: "2026-11-07T12:00:00.000Z" };
  // Provider signatures and database storage have integration coverage. This fixture
  // specifically tests the browser boundary for untrusted email content.
  await page.route("**/api/commerce", async route => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    const response = await route.fetch(), snapshot = await response.json();
    await route.fulfill({ response, json: { ...snapshot, inboundMessages: [fixture] } });
  });
  await page.route("**/api/commerce/inbound/881177", route => route.fulfill({ json: { ...fixture, text_body: plain, html_body: html, message_id: "synthetic-receipt" } }));
  const externalRequests: string[] = [];
  page.on("request", request => { if (request.url().includes("goose-test.invalid")) externalRequests.push(request.url()); });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Incoming AgentMail" })).toBeVisible();
  const receipt = page.locator("article.incoming-receipt").filter({ hasText: fixture.subject });
  await expect(receipt).toContainText("needs review");
  await receipt.getByRole("button", { name: "Read original email" }).click();
  await expect(receipt.getByLabel("Original plain-text body")).toBeVisible();
  expect(await receipt.getByLabel("Original plain-text body").textContent()).toBe(plain);
  await receipt.getByText("Original HTML source, displayed as text", { exact: true }).click();
  expect(await receipt.getByLabel("Original HTML source").textContent()).toBe(html);
  await expect(receipt.locator("img,script,iframe")).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __gooseInjected?: boolean }).__gooseInjected)).toBeUndefined();
  expect(externalRequests).toEqual([]);
  await receipt.getByRole("button", { name: "Hide original email" }).click();
  await expect(receipt.getByLabel("Original plain-text body")).toHaveCount(0);
});

test("a public inquiry links to a repository engineering assessment without changing its requested scope", async ({ page, context }) => {
  const nonce = Date.now(), organization = `Routing systems browser test ${nonce}`, email = `routing-${nonce}@example.test`;
  await page.goto("/contact");
  await page.getByLabel("Your name").fill("Playwright Tester");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Organization", { exact: true }).fill(organization);
  await page.getByLabel("What outcome do you need?").fill("Upgrade our dispatch routing engine while preserving its command interface and adding bounded route constraints.");
  await page.getByRole("checkbox", { name: /demonstration inquiry/ }).check();
  await page.getByRole("button", { name: "Send inquiry" }).click();
  await expect(page.getByText(/Inquiry received/)).toBeVisible();
  await page.getByRole("status").getByRole("link", { name: "Start a job ↗", exact: true }).click();
  await expect(page).toHaveURL(/\/start\?inquiry=/);
  await page.getByLabel("Business name").fill(organization);
  await page.getByLabel("Application name").fill("Dispatch routing engine");
  await page.getByLabel("Your name").fill("Playwright Tester");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Type of engineering work").selectOption("workspace");
  await expect(page.getByLabel("Target runtime (optional)")).toBeDisabled();
  await expect(page.getByLabel("Requested data changes (optional)")).toBeDisabled();
  await expect(page.getByText(/No Goose-specific configuration is required/)).toBeVisible();
  await page.getByLabel(/Your goal/).fill("Upgrade the dispatch routing CLI while preserving its existing JSON command interface and add bounded route constraints.");
  const source = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workspace-")), "routing.zip");
  execFileSync("/usr/bin/zip", ["-r", "-q", source, "."], { cwd: path.resolve("demo/workspace-routing/repo") });
  await page.getByRole("button", { name: "Upload a .zip instead" }).click();
  await page.locator("input[name=repository]").setInputFiles(source);
  await page.locator("input[name=demo]").check();
  await page.locator("input[name=authorized]").check();
  await page.getByRole("button", { name: "Begin migration" }).click();
  await expect(page).toHaveURL(/\/jobs\/GS-\d+\?t=/);
  await expect(page.getByText(/Autonomous discovery requires live Naive/).first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Accept proposal" })).toHaveCount(0);
  const jobId = new URL(page.url()).pathname.split("/").pop()!;
  const ops = await context.newPage();
  await signIn(ops, "/ops/business");
  const inquiry = ops.locator("article").filter({ has: ops.getByText(organization, { exact: true }) });
  await expect(inquiry.getByRole("link", { name: `Linked to ${jobId} ↗` })).toBeVisible();
  await ops.close();
});

test("a Rust request keeps its explicit target and requests live execution in local mode", async ({ page }) => {
  await page.goto("/start");
  await page.getByLabel("Business name").fill("Migration intake test");
  await page.getByLabel("Application name").fill("Rust booking service");
  await page.getByLabel("Your name").fill("Playwright Tester");
  await page.getByLabel("Email").fill("tester@example.test");
  await page.getByLabel(/Your goal/).fill("Migrate this application to Rust and keep its customer history.");
  await page.getByLabel("Type of engineering work").selectOption("service");
  await page.getByLabel("Target runtime (optional)").selectOption("rust");
  await page.getByLabel("Requested data changes (optional)").fill("Add a customer tier with a standard default.");
  await page.getByRole("button", { name: "Upload a .zip instead" }).click();   // the sample isn't on GitHub
  await page.getByLabel("Type of engineering work").selectOption("service");
  await page.locator("input[name=repository]").setInputFiles(clinicZip());
  await page.locator("input[name=database]").setInputFiles(path.join(CLINIC, "data", "clinic.db"));
  await page.locator("input[name=demo]").check();
  await page.locator("input[name=authorized]").check();
  await page.getByRole("button", { name: "Begin migration" }).click();
  await expect(page).toHaveURL(/\/jobs\/GS-\d+\?t=/);
  await expect(page.getByText("Migrate the application to Rust.", { exact: true }).first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/needs the live agent team on Naive/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept proposal" })).toHaveCount(0);
});
