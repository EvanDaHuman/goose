import { defineConfig } from "@playwright/test";

// Browser tests require a local-mode web UI and worker. Override GOOSE_URL for an isolated test server.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 9 * 60_000,
  expect: { timeout: 20_000 },
  // uses the installed Google Chrome (no browser download); set PW_CHANNEL= to use Playwright's own Chromium
  use: { baseURL: process.env.GOOSE_URL ?? "http://localhost:3100", channel: process.env.PW_CHANNEL ?? "chrome",
    headless: true, trace: "retain-on-failure", video: process.env.PW_VIDEO ? "on" : "off" },
  reporter: [["list"]],
});
