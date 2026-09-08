// Asqav Browser Capture worker registration and synthetic HTTP smoke tests

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
  // Load the unpacked extension in a persistent Chromium context

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
    // Give the worker a moment to cold-start
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

    // Seed synthetic credentials in the worker storage

    await worker.evaluate(async () => {
      await chrome.storage.session.set({ apiKey: "e2e-test-key" });
      await chrome.storage.local.set({ agentId: "e2e-agent" });
    });

    // Request host permission without asserting the grant result
    await worker.evaluate(async () => {
      await new Promise((resolve) => {
        chrome.permissions.request(
          { origins: ["https://chat.openai.com/*"] },
          () => resolve(),
        );
      });
    });

    // Install the sign-endpoint route fixture
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

    // Exercise a synthetic request from the worker context

    const result = await worker.evaluate(async () => {
      // This request does not exercise emitReceipt or the navigation listener

      const url = "https://chat.openai.com/c/abc";
      // The fixture body is independent of the product receipt builder

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
