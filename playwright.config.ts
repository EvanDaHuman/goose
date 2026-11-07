import { defineConfig } from "@playwright/test";

// Browser tests of the essential flows. Needs `npm start` (web UI on :3000 and the worker) running.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 9 * 60_000,
  expect: { timeout: 20_000 },
  // uses the installed Google Chrome (no browser download); set PW_CHANNEL= to use Playwright's own Chromium
  use: { baseURL: process.env.GOOSE_URL ?? "http://localhost:3000", channel: process.env.PW_CHANNEL ?? "chrome",
    headless: true, trace: "retain-on-failure", video: process.env.PW_VIDEO ? "on" : "off" },
  reporter: [["list"]],
});
