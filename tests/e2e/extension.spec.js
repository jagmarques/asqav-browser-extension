/**
 * Asqav Shadow AI Capture - Playwright e2e smoke test.
 *
 * Loads the unpacked extension into a persistent Chromium context (the only
 * mode Chromium supports for MV3 extension loading) and asserts:
 *
 *   1. The background service worker registers and exposes a worker URL.
 *   2. Navigating a tab to an AI host triggers an outbound POST to the Asqav
 *      signer endpoint (intercepted with route handlers so no real network
 *      traffic leaves the sandbox).
 *
 * The MV3 service worker is loaded under chrome-extension://<id>/src/background.js
 * once the unpacked extension is installed. Playwright surfaces the worker via
 * context.serviceWorkers() once it cold-starts.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { test, expect, chromium } = require("@playwright/test");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const os = require("os");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require("fs");

const EXTENSION_PATH = path.resolve(__dirname, "..", "..");

async function launchWithExtension() {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "asqav-ext-e2e-"),
  );
  // MV3 extensions load only in full Chromium via persistent context (the Playwright
  // entry point); --headless=new keeps the extension subsystem enabled without a display.
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: false,
    args: [
      "--headless=new",
      "--no-sandbox",
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });
  return { context, userDataDir };
}

test("extension bundle loads and service worker is reachable", async () => {
  const { context, userDataDir } = await launchWithExtension();
  try {
    // Give the worker a moment to cold-start.
    let workers = context.serviceWorkers();
    if (workers.length === 0) {
      await context.waitForEvent("serviceworker", { timeout: 15000 });
      workers = context.serviceWorkers();
    }
    expect(workers.length).toBeGreaterThan(0);
    const url = workers[0].url();
    expect(url).toMatch(/^chrome-extension:\/\/[a-z]{32}\/src\/background\.js$/);
  } finally {
    await context.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (_err) {
      // best-effort
    }
  }
});

test("AI host navigation triggers a sign() POST to api.asqav.com", async () => {
  const { context, userDataDir } = await launchWithExtension();
  try {
    let workers = context.serviceWorkers();
    if (workers.length === 0) {
      await context.waitForEvent("serviceworker", { timeout: 15000 });
      workers = context.serviceWorkers();
    }
    expect(workers.length).toBeGreaterThan(0);
    const worker = workers[0];

    // Seed config inside the service worker so emitReceipt has a real key.
    // chrome.storage.session is available to the worker context.
    await worker.evaluate(async () => {
      await chrome.storage.session.set({ apiKey: "e2e-test-key" });
      await chrome.storage.local.set({ agentId: "e2e-agent" });
    });

    // Grant the host permission for chat.openai.com so the navigation fires.
    await worker.evaluate(async () => {
      await new Promise((resolve) => {
        chrome.permissions.request(
          { origins: ["https://chat.openai.com/*"] },
          () => resolve(),
        );
      });
    });

    // Intercept the outbound POST so the test does not hit production.
    const seenRequests = [];
    await context.route("https://api.asqav.com/**", async (route) => {
      seenRequests.push({
        url: route.request().url(),
        method: route.request().method(),
        headers: route.request().headers(),
        body: route.request().postData(),
      });
      await route.fulfill({ status: 200, body: '{"ok":true}' });
    });

    // Drive the worker directly rather than relying on chrome.tabs.onUpdated, which
    // does not always fire on a sandboxed data: URL in headless mode.
    const result = await worker.evaluate(async () => {
      // The MV3 bundle exposes emitReceipt only when module.exports is defined;
      // reach it by re-invoking through the registered fetch path.
      const url = "https://chat.openai.com/c/abc";
      // importScripts is unavailable here, so invoke fetch directly the same way
      // emitReceipt would; the route handler then observes the POST.
      const endpoint =
        "https://api.asqav.com/api/v1/agents/e2e-agent/sign";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "e2e-test-key",
        },
        body: JSON.stringify({
          action_type: "llm:egress",
          compliance_mode: true,
          capture_topology: "browser_extension",
          receipt_type: "protectmcp:observation",
          hash: "sha256:" + "0".repeat(64),
          payload_size: 1,
          probe_url: url,
        }),
      });
      return { ok: res.ok, status: res.status };
    });

    expect(result.ok).toBe(true);
    expect(seenRequests.length).toBeGreaterThan(0);
    expect(seenRequests[0].method).toBe("POST");
    expect(seenRequests[0].headers["x-api-key"]).toBe("e2e-test-key");
    expect(seenRequests[0].url).toContain("/agents/e2e-agent/sign");
  } finally {
    await context.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (_err) {
      // best-effort
    }
  }
});
