import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

// The sample Django booking site from the engine's test fixtures, zipped as a customer would upload it.
const CLINIC = path.resolve("engine/tests/fixtures/samples/django-clinic");
function clinicZip() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2e-")), "clinic.zip");
  execFileSync("/usr/bin/zip", ["-r", "-q", out, ".", "-x", "*.db", "-x", "__pycache__/*", "-x", "*.pyc"], { cwd: path.join(CLINIC, "repo") });
  return out;
}

test("landing page states the promise, what the customer provides, what we carry out today, and the pilot prices", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /An AI team that plans and delivers upgrades/i })).toBeVisible();
  await expect(page.getByText("What you provide")).toBeVisible();
  await expect(page.getByText("What we carry out today")).toBeVisible();
  await expect(page.getByText(/Pilot prices/)).toBeVisible();
});

test("a customer's goal on a Django app becomes a plan, a fixed price, a verified delivery and a test invoice", async ({ page }) => {
  await page.goto("/start");
  await page.getByLabel("Business name").fill("Sample Clinic (test)");
  await page.getByLabel("Application name").fill("Sample Clinic booking site");
  await page.getByLabel("Your name").fill("Playwright Tester");
  await page.getByLabel("Email").fill("tester@example.com");
  await page.getByLabel(/Business time zone/).selectOption("America/New_York");
  await page.getByLabel(/Your goal/).fill("Bring our booking site onto a supported Django version. The pages, the reception kiosk feed and " +
    "the reminder script must keep working exactly as today.");
  for (const c of ["keep_database", "keep_api", "keep_connections"]) await page.locator(`input[name=constraints][value=${c}]`).check();
  await page.getByLabel(/Application or repository/).setInputFiles(clinicZip());
  await page.getByLabel(/Copy of the data/).setInputFiles(path.join(CLINIC, "data", "clinic.db"));
  await page.locator("input[name=demo]").check();
  await page.locator("input[name=authorized]").check();
  await page.getByRole("button", { name: "Send for inspection and a plan" }).click();
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
  await page.getByRole("checkbox").last().check();
  await page.getByRole("button", { name: "Accept proposal" }).click();
  // record, freeze, change, verify - then the delivery appears
  await expect(page.getByRole("heading", { name: "Delivery" })).toBeVisible({ timeout: 6 * 60_000 });
  await expect(page.getByText("All mandatory checks passed").first()).toBeVisible();
  await expect(page.getByText(/Before and after/)).toBeVisible();
  await page.getByLabel("Your name").fill("Playwright Tester");
  await page.getByRole("checkbox").last().check();
  await page.getByRole("button", { name: "Accept the delivery" }).click();
  await expect(page.getByRole("heading", { name: /Invoice TEST-GS-INV-/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Test invoice - not sent, nothing owed")).toBeVisible();
});

test("the operator view shows the job, its responsible agent and its spend", async ({ page }) => {
  await page.goto("/ops");
  await expect(page.getByRole("heading", { name: "Operator" })).toBeVisible();
  await expect(page.getByText("Local mode - no AI", { exact: true })).toBeVisible();
  const first = page.locator("tbody tr").first();
  await expect(first).toContainText("GS-");
  await first.getByRole("link").first().click();
  await expect(page.getByRole("heading", { name: "Customer approvals" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Founder interventions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Spending" })).toBeVisible();
});

test("a Rust request keeps its explicit target and requests live execution in local mode", async ({ page }) => {
  await page.goto("/start");
  await page.getByLabel("Business name").fill("Migration intake test");
  await page.getByLabel("Application name").fill("Rust booking service");
  await page.getByLabel("Your name").fill("Playwright Tester");
  await page.getByLabel("Email").fill("tester@example.test");
  await page.getByLabel(/Your goal/).fill("Migrate this application to Rust and keep its customer history.");
  await page.getByLabel("Target runtime (optional)").selectOption("rust");
  await page.getByLabel("Requested data changes (optional)").fill("Add a customer tier with a standard default.");
  await page.getByLabel(/Application or repository/).setInputFiles(clinicZip());
  await page.getByLabel(/Copy of the data/).setInputFiles(path.join(CLINIC, "data", "clinic.db"));
  await page.locator("input[name=demo]").check();
  await page.locator("input[name=authorized]").check();
  await page.getByRole("button", { name: "Send for inspection and a plan" }).click();
  await expect(page).toHaveURL(/\/jobs\/GS-\d+\?t=/);
  await expect(page.getByText("Migrate the application to Rust.", { exact: true }).first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/needs the live agent team on Naive/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept proposal" })).toHaveCount(0);
});
