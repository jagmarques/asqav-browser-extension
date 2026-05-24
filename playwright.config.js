/**
 * Playwright config for the Asqav Shadow AI Capture extension.
 *
 * The e2e suite loads the unpacked extension into a persistent Chromium
 * context and asserts the service worker registers and emits receipts. The
 * Jest unit suite stays as the fast feedback loop; Playwright covers the
 * "does the bundle actually load in a real Chromium" gap.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 60 * 1000,
  use: {
    headless: true,
    trace: "off",
  },
});
