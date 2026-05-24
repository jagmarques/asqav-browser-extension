/**
 * Asqav Shadow AI Capture - background.js unit tests.
 *
 * Drives the service-worker module in a CommonJS Jest harness with a mocked
 * chrome.* surface. Validates:
 *   1. AI-domain detection fires on chat.openai.com and skips wikipedia.org.
 *   2. emitReceipt invokes fetch with the expected SignRequest shape and
 *      headers when config is present.
 *   3. The receipt body matches the cloud SignRequest field contract
 *      (action_type, compliance_mode, capture_topology, receipt_type, hash,
 *      payload_size).
 */

// --- chrome global mock (installed before require) ---------------------------

const tabListeners = [];
global.chrome = {
  tabs: {
    onUpdated: {
      addListener: (fn) => tabListeners.push(fn),
    },
  },
  storage: {
    local: {
      _store: {},
      get: (keys) =>
        Promise.resolve(
          Object.fromEntries(
            keys.map((k) => [k, global.chrome.storage.local._store[k]]),
          ),
        ),
      set: (obj) => {
        Object.assign(global.chrome.storage.local._store, obj);
        return Promise.resolve();
      },
    },
  },
  identity: {
    getProfileUserInfo: (cb) => cb({ email: "" }),
  },
};

// crypto.subtle is provided by Node 20+ via the global `crypto` namespace.
// Force-bind it so tests run under both Node 18 (with --experimental-global-webcrypto)
// and Node 20+.
if (!global.crypto || !global.crypto.subtle) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { webcrypto } = require("crypto");
  global.crypto = webcrypto;
}

const bg = require("../src/background.js");

// --- 1. AI-domain detection --------------------------------------------------

describe("isAiDomain", () => {
  test("matches chat.openai.com", () => {
    expect(bg.isAiDomain("https://chat.openai.com/c/abc123")).toBe(true);
  });

  test("matches claude.ai", () => {
    expect(bg.isAiDomain("https://claude.ai/chats/foo")).toBe(true);
  });

  test("matches github.com/copilot path-scoped", () => {
    expect(bg.isAiDomain("https://github.com/copilot")).toBe(true);
    expect(bg.isAiDomain("https://github.com/copilot/anything")).toBe(true);
  });

  test("does NOT match wikipedia.org", () => {
    expect(bg.isAiDomain("https://en.wikipedia.org/wiki/AI")).toBe(false);
  });

  test("does NOT match bare github.com without /copilot", () => {
    expect(bg.isAiDomain("https://github.com/anthropics/claude")).toBe(false);
  });

  test("does NOT match malformed URL", () => {
    expect(bg.isAiDomain("not a url")).toBe(false);
  });
});

// --- 2. Receipt body shape ---------------------------------------------------

describe("buildReceiptBody", () => {
  test("matches the cloud SignRequest field contract", async () => {
    const body = await bg.buildReceiptBody({
      domain: "chat.openai.com",
      tabSessionId: "tab:42",
      observedAt: "2026-05-24T12:00:00.000Z",
      userId: "alice@example.com",
    });
    // Required fields per cloud SignRequest + IETF -04 envelope.
    expect(body).toHaveProperty("action_type", "llm:egress");
    expect(body).toHaveProperty("compliance_mode", true);
    expect(body).toHaveProperty("capture_topology", "browser_extension");
    expect(body).toHaveProperty("receipt_type", "protectmcp:observation");
    expect(body).toHaveProperty("hash");
    expect(body.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body).toHaveProperty("payload_size");
    expect(typeof body.payload_size).toBe("number");
    expect(body.payload_size).toBeGreaterThan(0);
  });

  test("is deterministic for the same input (JCS guarantee)", async () => {
    const ctx = {
      domain: "claude.ai",
      tabSessionId: "tab:1",
      observedAt: "2026-05-24T00:00:00.000Z",
      userId: "bob@example.com",
    };
    const a = await bg.buildReceiptBody(ctx);
    const b = await bg.buildReceiptBody(ctx);
    expect(a.hash).toBe(b.hash);
    expect(a.payload_size).toBe(b.payload_size);
  });
});

// --- 3. emitReceipt routing + skip semantics ---------------------------------

describe("emitReceipt", () => {
  beforeEach(async () => {
    global.chrome.storage.local._store = {
      apiKey: "test-api-key",
      agentId: "agent-abc",
    };
  });

  test("POSTs to the signer when URL is on the AI-domain list", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 });
    const res = await bg.emitReceipt(
      { url: "https://chat.openai.com/c/abc", tabId: 7 },
      { fetchImpl: fetchMock, now: () => "2026-05-24T00:00:00.000Z" },
    );
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.asqav.com/api/v1/agents/agent-abc/sign",
    );
    expect(init.method).toBe("POST");
    expect(init.headers["X-API-Key"]).toBe("test-api-key");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const parsed = JSON.parse(init.body);
    expect(parsed.action_type).toBe("llm:egress");
    expect(parsed.compliance_mode).toBe(true);
    expect(parsed.capture_topology).toBe("browser_extension");
    expect(parsed.receipt_type).toBe("protectmcp:observation");
    expect(parsed.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(typeof parsed.payload_size).toBe("number");
  });

  test("does NOT POST when URL is not on the AI-domain list", async () => {
    const fetchMock = jest.fn();
    const res = await bg.emitReceipt(
      { url: "https://en.wikipedia.org/wiki/AI", tabId: 9 },
      { fetchImpl: fetchMock },
    );
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe("not_ai_domain");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("does NOT POST when config is missing", async () => {
    global.chrome.storage.local._store = {};
    const fetchMock = jest.fn();
    const res = await bg.emitReceipt(
      { url: "https://chat.openai.com/c/abc", tabId: 1 },
      { fetchImpl: fetchMock },
    );
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe("no_config");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// --- 4. tab listener wires through to emitReceipt ----------------------------

describe("registerTabListener", () => {
  test("a registered listener exists from cold-start side effect", () => {
    expect(tabListeners.length).toBeGreaterThan(0);
  });
});
