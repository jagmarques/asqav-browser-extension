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
 *   4. Failed receipts get queued in storage.local.pendingReceipts (FIFO,
 *      capped at PENDING_QUEUE_MAX).
 *   5. drainPending retries queued entries and drops them on 2xx.
 *   6. maybeNotify throttles per error class.
 *   7. loadConfig reads apiKey from storage.session and agentId from
 *      storage.local; falls back to local for apiKey when session is missing.
 */

// --- chrome global mock (installed before require) ---------------------------

const tabListeners = [];
const alarmListeners = [];
const createdAlarms = [];
const createdNotifications = [];
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
            (Array.isArray(keys) ? keys : [keys]).map((k) => [
              k,
              global.chrome.storage.local._store[k],
            ]),
          ),
        ),
      set: (obj) => {
        Object.assign(global.chrome.storage.local._store, obj);
        return Promise.resolve();
      },
    },
    session: {
      _store: {},
      get: (keys) =>
        Promise.resolve(
          Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map((k) => [
              k,
              global.chrome.storage.session._store[k],
            ]),
          ),
        ),
      set: (obj) => {
        Object.assign(global.chrome.storage.session._store, obj);
        return Promise.resolve();
      },
    },
  },
  identity: {
    getProfileUserInfo: (cb) => cb({ email: "" }),
  },
  alarms: {
    create: (name, opts) => createdAlarms.push({ name, opts }),
    onAlarm: {
      addListener: (fn) => alarmListeners.push(fn),
    },
  },
  notifications: {
    create: (id, opts) => createdNotifications.push({ id, opts }),
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

function resetStores() {
  global.chrome.storage.local._store = {};
  global.chrome.storage.session._store = {};
  createdNotifications.length = 0;
}

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
  beforeEach(() => {
    resetStores();
    global.chrome.storage.session._store = {
      apiKey: "test-api-key",
    };
    global.chrome.storage.local._store = {
      agentId: "agent-abc",
    };
  });

  test("POSTs to the signer when URL is on the AI-domain list", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const res = await bg.emitReceipt(
      { url: "https://chat.openai.com/c/abc", tabId: 7 },
      { fetchImpl: fetchMock, now: () => "2026-05-24T00:00:00.000Z" },
    );
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.asqav.com/api/v1/agents/agent-abc/sign");
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
    resetStores();
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

// --- 5. retry alarm + queue --------------------------------------------------

describe("retry queue", () => {
  beforeEach(() => {
    resetStores();
    global.chrome.storage.session._store = { apiKey: "k" };
    global.chrome.storage.local._store = { agentId: "a" };
  });

  test("alarm is registered on cold start", () => {
    const names = createdAlarms.map((a) => a.name);
    expect(names).toContain(bg.RETRY_ALARM_NAME);
  });

  test("alarm listener is registered on cold start", () => {
    expect(alarmListeners.length).toBeGreaterThan(0);
  });

  test("non-2xx response queues the receipt", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 503 });
    const res = await bg.emitReceipt(
      { url: "https://chat.openai.com/", tabId: 1 },
      { fetchImpl: fetchMock, nowMs: () => 1000 },
    );
    expect(res.ok).toBe(false);
    expect(res.queued).toBe(true);
    const pending = await bg.getPending();
    expect(pending.length).toBe(1);
    expect(pending[0].endpoint).toContain("/agents/a/sign");
    expect(pending[0].apiKey).toBe("k");
  });

  test("network throw also queues", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new TypeError("offline"));
    const res = await bg.emitReceipt(
      { url: "https://chat.openai.com/", tabId: 2 },
      { fetchImpl: fetchMock, nowMs: () => 2000 },
    );
    expect(res.ok).toBe(false);
    expect(res.queued).toBe(true);
    const pending = await bg.getPending();
    expect(pending.length).toBe(1);
  });

  test("queue is FIFO-capped at PENDING_QUEUE_MAX", async () => {
    // Pre-seed past the cap with synthetic entries.
    const seed = [];
    for (let i = 0; i < bg.PENDING_QUEUE_MAX; i += 1) {
      seed.push({ endpoint: "x", apiKey: "k", body: { i }, enqueuedAt: "t" });
    }
    await bg.setPending(seed);
    await bg.enqueuePending({
      endpoint: "y",
      apiKey: "k",
      body: { i: "new" },
      enqueuedAt: "t",
    });
    const pending = await bg.getPending();
    expect(pending.length).toBe(bg.PENDING_QUEUE_MAX);
    // Oldest dropped, newest at tail.
    expect(pending[0].body.i).toBe(1);
    expect(pending[pending.length - 1].body.i).toBe("new");
  });

  test("drainPending retries entries and clears on 2xx", async () => {
    await bg.setPending([
      { endpoint: "https://api.asqav.com/x", apiKey: "k", body: {} },
      { endpoint: "https://api.asqav.com/y", apiKey: "k", body: {} },
    ]);
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const result = await bg.drainPending({
      fetchImpl: fetchMock,
      nowMs: () => 3000,
    });
    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.remaining).toBe(0);
    expect(await bg.getPending()).toEqual([]);
  });

  test("drainPending keeps failures and clears successes", async () => {
    await bg.setPending([
      { endpoint: "https://api.asqav.com/x", apiKey: "k", body: { i: 1 } },
      { endpoint: "https://api.asqav.com/y", apiKey: "k", body: { i: 2 } },
    ]);
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    const result = await bg.drainPending({
      fetchImpl: fetchMock,
      nowMs: () => 4000,
    });
    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.remaining).toBe(1);
    const remaining = await bg.getPending();
    expect(remaining.length).toBe(1);
    expect(remaining[0].body.i).toBe(2);
  });
});

// --- 6. notification throttle ------------------------------------------------

describe("maybeNotify", () => {
  beforeEach(() => {
    resetStores();
  });

  test("fires once per error class within the throttle window", async () => {
    await bg.maybeNotify("server_5xx", "msg one", { nowMs: () => 1000 });
    await bg.maybeNotify("server_5xx", "msg two", { nowMs: () => 2000 });
    expect(createdNotifications.length).toBe(1);
  });

  test("re-fires after throttle window elapses", async () => {
    await bg.maybeNotify("server_5xx", "msg one", { nowMs: () => 1000 });
    await bg.maybeNotify("server_5xx", "msg two", {
      nowMs: () => 1000 + bg.NOTIFY_THROTTLE_MS + 1,
    });
    expect(createdNotifications.length).toBe(2);
  });

  test("different error classes do not share the throttle", async () => {
    await bg.maybeNotify("server_5xx", "a", { nowMs: () => 1000 });
    await bg.maybeNotify("network", "b", { nowMs: () => 1000 });
    expect(createdNotifications.length).toBe(2);
  });
});

// --- 7. loadConfig session vs local routing ----------------------------------

describe("loadConfig", () => {
  beforeEach(() => {
    resetStores();
  });

  test("reads apiKey from session and agentId from local", async () => {
    global.chrome.storage.session._store = { apiKey: "sess-key" };
    global.chrome.storage.local._store = { agentId: "agent-1" };
    const cfg = await bg.loadConfig();
    expect(cfg).toEqual({ apiKey: "sess-key", agentId: "agent-1" });
  });

  test("falls back to local apiKey when session has nothing", async () => {
    global.chrome.storage.local._store = {
      apiKey: "fallback-key",
      agentId: "agent-2",
    };
    const cfg = await bg.loadConfig();
    expect(cfg).toEqual({ apiKey: "fallback-key", agentId: "agent-2" });
  });

  test("returns null when agentId is missing", async () => {
    global.chrome.storage.session._store = { apiKey: "k" };
    const cfg = await bg.loadConfig();
    expect(cfg).toBeNull();
  });

  test("returns null when apiKey is missing", async () => {
    global.chrome.storage.local._store = { agentId: "agent" };
    const cfg = await bg.loadConfig();
    expect(cfg).toBeNull();
  });
});

// --- 8. classifyError --------------------------------------------------------

describe("classifyError", () => {
  test("5xx status -> server_5xx", () => {
    expect(bg.classifyError(null, 503)).toBe("server_5xx");
  });
  test("4xx status -> client_4xx", () => {
    expect(bg.classifyError(null, 401)).toBe("client_4xx");
  });
  test("AbortError -> abort", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(bg.classifyError(err, undefined)).toBe("abort");
  });
  test("everything else -> network", () => {
    expect(bg.classifyError(new TypeError("offline"), undefined)).toBe(
      "network",
    );
  });
});
