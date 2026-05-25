/**
 * Asqav Shadow AI Capture - service worker.
 *
 * Listens for tab navigation events, matches the destination host against the
 * Asqav AI-domain seed list, and emits an IETF-aligned compliance receipt to
 * the Asqav signer cloud. Metadata-only by default; the receipt body never
 * includes the prompt content.
 *
 * Endpoint: POST https://api.asqav.com/api/v1/agents/<agent_id>/sign
 * Auth:     X-API-Key header sourced from chrome.storage.session (apiKey) and
 *           chrome.storage.local (agentId).
 *
 * Credential and transport contract:
 *   - API key reads from chrome.storage.session (in-memory, not readable by
 *     other extensions, cleared on browser restart).
 *   - Failed POSTs queue into chrome.storage.local.pendingReceipts (FIFO,
 *     cap 100) and retry on a chrome.alarms tick every 5 minutes.
 *   - chrome.notifications fires at most once per hour per error class so
 *     operators see persistent failures without notification spam.
 *
 * Overflow and MDM contract:
 *   - Retry-queue overflow surfaces an archive bounded at PENDING_ARCHIVE_MAX
 *     plus an incremented metricsReceiptsDropped counter rather than a silent
 *     drop. The counter renders on the options page so SOC tooling can detect
 *     evidence loss.
 *   - chrome.storage.managed policy hook auto-enables detection, host
 *     permissions, and credentials on MDM-managed devices via the keys
 *     mdmAutoEnable, mdmApiKey, mdmApiEndpoint, mdmManagedHosts.
 *
 * Cloud dependency: the cloud's SignRequest receipt_type Literal must include
 * "protectmcp:observation" for posts from this extension to be accepted.
 */

const ASQAV_ENDPOINT_BASE = "https://api.asqav.com/api/v1/agents";
const RECEIPT_TYPE = "protectmcp:observation";
const ACTION_TYPE = "llm:egress";
const CAPTURE_TOPOLOGY = "browser_extension";

// Retry queue knobs.
const PENDING_QUEUE_KEY = "pendingReceipts";
const PENDING_QUEUE_MAX = 100;
const PENDING_ARCHIVE_KEY = "pendingReceiptsArchive";
const PENDING_ARCHIVE_MAX = 1000;
const METRICS_DROPPED_KEY = "metricsReceiptsDropped";
const METRICS_ARCHIVE_OVERFLOW_KEY = "metricsArchiveOverflow";
const RETRY_ALARM_NAME = "asqav-retry-pending";
const RETRY_ALARM_MINUTES = 5;

// Notification throttle. Stored last-fired-at-ms per error class in
// chrome.storage.local under the "errorNotifiedAt" object.
const NOTIFY_THROTTLE_MS = 60 * 60 * 1000;
const NOTIFY_KEY = "errorNotifiedAt";

// MDM policy keys read from chrome.storage.managed.
const MDM_KEYS = [
  "mdmAutoEnable",
  "mdmApiKey",
  "mdmApiEndpoint",
  "mdmManagedHosts",
];

// Override of the default endpoint base, set by the MDM hook when
// mdmApiEndpoint is present. Read by emitReceipt and drainPending.
let runtimeEndpointBase = ASQAV_ENDPOINT_BASE;

// Inlined seed list (the JSON file is bundled but the service worker must not
// rely on fetch() against extension-local URLs in MV3 cold-start paths).
const AI_DOMAIN_SEED = [
  "chat.openai.com",
  "chatgpt.com",
  "openai.com",
  "platform.openai.com",
  "api.openai.com",
  "claude.ai",
  "anthropic.com",
  "api.anthropic.com",
  "gemini.google.com",
  "bard.google.com",
  "generativelanguage.googleapis.com",
  "copilot.microsoft.com",
  "perplexity.ai",
  "www.perplexity.ai",
  "mistral.ai",
  "chat.mistral.ai",
  "api.mistral.ai",
  "cohere.com",
  "cohere.ai",
  "dashboard.cohere.com",
  "huggingface.co",
  "hf.co",
  "you.com",
  "phind.com",
  "xai.com",
  "x.ai",
  "grok.x.ai",
];

// Path-scoped matches: only fire when the URL path begins with one of the
// listed prefixes (e.g., github.com/copilot but not github.com generally).
const AI_DOMAIN_PATH_SCOPED = {
  "github.com": ["/copilot"],
};

/**
 * Determine whether a URL points at a known AI tool.
 * @param {string} urlString
 * @returns {boolean}
 */
function isAiDomain(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch (_err) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (AI_DOMAIN_SEED.includes(host)) {
    return true;
  }
  if (host in AI_DOMAIN_PATH_SCOPED) {
    return AI_DOMAIN_PATH_SCOPED[host].some((prefix) =>
      url.pathname.startsWith(prefix),
    );
  }
  return false;
}

/**
 * JCS (JSON Canonicalization Scheme, RFC 8785) - minimal implementation
 * sufficient for the context bag shape this extension emits. Keys are sorted
 * lexicographically; strings are JSON-escaped per RFC 8259; numbers follow the
 * RFC 8785 number serialization rules for the subset we use (integers only).
 *
 * The cloud verifier re-canonicalises and recomputes the hash, so this side
 * only needs to be deterministic across browser sessions.
 *
 * @param {unknown} value
 * @returns {string}
 */
function jcsStringify(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("jcs: non-finite number");
    }
    return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(jcsStringify).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = keys.map(
      (k) => JSON.stringify(k) + ":" + jcsStringify(value[k]),
    );
    return "{" + parts.join(",") + "}";
  }
  throw new Error("jcs: unsupported type " + typeof value);
}

/**
 * Compute SHA-256 of a UTF-8 string and return a "sha256:<hex>" tag.
 * Uses the WebCrypto API available in MV3 service workers.
 *
 * @param {string} text
 * @returns {Promise<string>}
 */
async function sha256Tag(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return "sha256:" + hex;
}

/**
 * Build the receipt payload that gets POSTed to the Asqav signer.
 *
 * @param {{ domain: string, tabSessionId: string, observedAt: string, userId: string }} ctx
 * @returns {Promise<object>}
 */
async function buildReceiptBody(ctx) {
  const contextBag = {
    domain: ctx.domain,
    tab_session_id: ctx.tabSessionId,
    observed_at: ctx.observedAt,
    user_id: ctx.userId,
  };
  const canonical = jcsStringify(contextBag);
  const hash = await sha256Tag(canonical);
  const payloadSize = new TextEncoder().encode(canonical).byteLength;
  return {
    action_type: ACTION_TYPE,
    compliance_mode: true,
    capture_topology: CAPTURE_TOPOLOGY,
    receipt_type: RECEIPT_TYPE,
    hash,
    payload_size: payloadSize,
  };
}

/**
 * Fetch config. apiKey is sourced from chrome.storage.session (in-memory) and
 * agentId from chrome.storage.local (persisted). Returns null when either
 * field is missing so callers can short-circuit before opening a network
 * connection.
 *
 * @returns {Promise<{apiKey: string, agentId: string} | null>}
 */
async function loadConfig() {
  if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) {
    return null;
  }
  const { agentId } = await chrome.storage.local.get(["agentId"]);
  let apiKey;
  if (chrome.storage.session && chrome.storage.session.get) {
    const sessionPart = await chrome.storage.session.get(["apiKey"]);
    apiKey = sessionPart.apiKey;
  }
  // Fallback for environments without storage.session: read from local. The
  // options page documents the downgrade.
  if (!apiKey) {
    const localPart = await chrome.storage.local.get(["apiKey"]);
    apiKey = localPart.apiKey;
  }
  if (!apiKey || !agentId) return null;
  return { apiKey, agentId };
}

/**
 * Best-effort browser profile email lookup. Returns "" when unavailable; the
 * cloud falls back to the install-token-derived user identity in that case.
 *
 * @returns {Promise<string>}
 */
async function getProfileEmail() {
  try {
    if (
      globalThis.chrome &&
      chrome.identity &&
      typeof chrome.identity.getProfileUserInfo === "function"
    ) {
      return await new Promise((resolve) => {
        try {
          chrome.identity.getProfileUserInfo((info) => {
            resolve((info && info.email) || "");
          });
        } catch (_err) {
          resolve("");
        }
      });
    }
  } catch (_err) {
    // fall through
  }
  return "";
}

/**
 * Append a failed receipt to the pending queue. When the queue exceeds
 * PENDING_QUEUE_MAX the oldest entry is MOVED to the archive (not dropped)
 * and the metricsReceiptsDropped counter is incremented so a SOC monitoring
 * the extension can detect that receipts overflowed the live queue. If the
 * archive itself overflows, the very oldest archive entry is removed and the
 * metricsArchiveOverflow counter is incremented; a notification fires so the
 * operator learns about evidence loss.
 *
 * @param {{ endpoint: string, apiKey: string, body: object, enqueuedAt: string }} entry
 * @param {{ nowMs?: () => number }} [deps]
 */
async function enqueuePending(entry, deps = {}) {
  if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) return;
  const fields = await chrome.storage.local.get([
    PENDING_QUEUE_KEY,
    PENDING_ARCHIVE_KEY,
    METRICS_DROPPED_KEY,
    METRICS_ARCHIVE_OVERFLOW_KEY,
  ]);
  const existing = Array.isArray(fields[PENDING_QUEUE_KEY])
    ? fields[PENDING_QUEUE_KEY].slice()
    : [];
  const archive = Array.isArray(fields[PENDING_ARCHIVE_KEY])
    ? fields[PENDING_ARCHIVE_KEY].slice()
    : [];
  let droppedCount = Number(fields[METRICS_DROPPED_KEY] || 0);
  let archiveOverflow = Number(fields[METRICS_ARCHIVE_OVERFLOW_KEY] || 0);

  existing.push(entry);
  let archiveTriggered = false;
  let archiveOverflowTriggered = false;
  while (existing.length > PENDING_QUEUE_MAX) {
    const evicted = existing.shift();
    droppedCount += 1;
    archiveTriggered = true;
    archive.push(evicted);
    while (archive.length > PENDING_ARCHIVE_MAX) {
      archive.shift();
      archiveOverflow += 1;
      archiveOverflowTriggered = true;
    }
  }

  await chrome.storage.local.set({
    [PENDING_QUEUE_KEY]: existing,
    [PENDING_ARCHIVE_KEY]: archive,
    [METRICS_DROPPED_KEY]: droppedCount,
    [METRICS_ARCHIVE_OVERFLOW_KEY]: archiveOverflow,
  });

  if (archiveTriggered) {
    // Structured event for SOC log scrapers tailing the service-worker console.
    try {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          event: "asqav.receipt.queue_overflow",
          dropped_total: droppedCount,
          archive_size: archive.length,
          archive_overflow_total: archiveOverflow,
        }),
      );
    } catch (_err) {
      // best-effort
    }
    await maybeNotify(
      "queue_overflow",
      "Asqav retry queue overflowed. " +
        droppedCount +
        " receipt(s) moved to archive. Check the options page.",
      deps,
    );
  }
  if (archiveOverflowTriggered) {
    try {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          event: "asqav.receipt.archive_overflow",
          archive_overflow_total: archiveOverflow,
        }),
      );
    } catch (_err) {
      // best-effort
    }
    await maybeNotify(
      "archive_overflow",
      "Asqav receipt archive full. Evidence is being lost. Contact your Asqav admin.",
      deps,
    );
  }
}

/**
 * Atomically replace the pending queue.
 *
 * @param {Array} entries
 */
async function setPending(entries) {
  if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) return;
  await chrome.storage.local.set({ [PENDING_QUEUE_KEY]: entries });
}

/**
 * Read the pending queue (always returns an array).
 *
 * @returns {Promise<Array>}
 */
async function getPending() {
  if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) return [];
  const { [PENDING_QUEUE_KEY]: existing = [] } = await chrome.storage.local.get(
    [PENDING_QUEUE_KEY],
  );
  return Array.isArray(existing) ? existing : [];
}

/**
 * Read the archive queue (always returns an array). The archive holds entries
 * that overflowed the live retry queue so SOC tooling can inspect lost
 * evidence and the options page can surface counts.
 *
 * @returns {Promise<Array>}
 */
async function getArchive() {
  if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) return [];
  const { [PENDING_ARCHIVE_KEY]: existing = [] } =
    await chrome.storage.local.get([PENDING_ARCHIVE_KEY]);
  return Array.isArray(existing) ? existing : [];
}

/**
 * Read the dropped-receipt metrics counters.
 *
 * @returns {Promise<{ dropped: number, archiveOverflow: number, archiveSize: number, queueSize: number }>}
 */
async function getDropMetrics() {
  if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) {
    return { dropped: 0, archiveOverflow: 0, archiveSize: 0, queueSize: 0 };
  }
  const fields = await chrome.storage.local.get([
    METRICS_DROPPED_KEY,
    METRICS_ARCHIVE_OVERFLOW_KEY,
    PENDING_ARCHIVE_KEY,
    PENDING_QUEUE_KEY,
  ]);
  return {
    dropped: Number(fields[METRICS_DROPPED_KEY] || 0),
    archiveOverflow: Number(fields[METRICS_ARCHIVE_OVERFLOW_KEY] || 0),
    archiveSize: Array.isArray(fields[PENDING_ARCHIVE_KEY])
      ? fields[PENDING_ARCHIVE_KEY].length
      : 0,
    queueSize: Array.isArray(fields[PENDING_QUEUE_KEY])
      ? fields[PENDING_QUEUE_KEY].length
      : 0,
  };
}

/**
 * Fire a chrome.notifications notification, throttled to at most once per
 * NOTIFY_THROTTLE_MS per error class so persistent failures do not spam the
 * operator. Errors here are swallowed; user feedback is best-effort.
 *
 * @param {string} errorClass
 * @param {string} message
 * @param {{ nowMs?: () => number }} [deps]
 */
async function maybeNotify(errorClass, message, deps = {}) {
  if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) return;
  const nowMs = deps.nowMs || (() => Date.now());
  const { [NOTIFY_KEY]: book = {} } = await chrome.storage.local.get([
    NOTIFY_KEY,
  ]);
  const lastAt = (book && book[errorClass]) || 0;
  const now = nowMs();
  // lastAt === 0 means we have never fired for this class; allow through.
  if (lastAt !== 0 && now - lastAt < NOTIFY_THROTTLE_MS) return;
  const nextBook = Object.assign({}, book, { [errorClass]: now });
  await chrome.storage.local.set({ [NOTIFY_KEY]: nextBook });
  if (chrome.notifications && chrome.notifications.create) {
    try {
      chrome.notifications.create("", {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Asqav Shadow AI Capture",
        message,
        priority: 0,
      });
    } catch (_err) {
      // best-effort
    }
  }
}

/**
 * Categorise a fetch failure into a short error class so notifications are
 * throttled per category rather than per request.
 *
 * @param {unknown} err
 * @param {number | undefined} status
 * @returns {string}
 */
function classifyError(err, status) {
  if (status && status >= 500) return "server_5xx";
  if (status && status >= 400) return "client_4xx";
  if (err && typeof err === "object" && err.name === "AbortError") {
    return "abort";
  }
  return "network";
}

/**
 * Attempt to POST a receipt. Returns { ok, status } on success or any
 * non-network error response, throws on transport failure.
 *
 * @param {{ endpoint: string, apiKey: string, body: object }} req
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 */
async function postReceipt(req, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const res = await fetchImpl(req.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": req.apiKey,
    },
    body: JSON.stringify(req.body),
  });
  return { ok: Boolean(res.ok), status: res.status };
}

/**
 * Emit a receipt for one observed AI-tool navigation. Network failure or any
 * non-2xx response queues the receipt for the retry alarm to drain.
 *
 * @param {{ url: string, tabId: number }} navEvent
 * @param {{ fetchImpl?: typeof fetch, now?: () => string, nowMs?: () => number }} [deps]
 * @returns {Promise<{ ok: boolean, status?: number, skipped?: string, queued?: boolean }>}
 */
async function emitReceipt(navEvent, deps = {}) {
  if (!isAiDomain(navEvent.url)) {
    return { ok: false, skipped: "not_ai_domain" };
  }
  const config = await loadConfig();
  if (!config) {
    return { ok: false, skipped: "no_config" };
  }
  const now = deps.now || (() => new Date().toISOString());
  const domain = new URL(navEvent.url).hostname.toLowerCase();
  const userId = (await getProfileEmail()) || ("agent:" + config.agentId);
  const body = await buildReceiptBody({
    domain,
    tabSessionId: "tab:" + String(navEvent.tabId),
    observedAt: now(),
    userId,
  });
  const base = deps.endpointBase || runtimeEndpointBase;
  const endpoint =
    base + "/" + encodeURIComponent(config.agentId) + "/sign";
  const req = { endpoint, apiKey: config.apiKey, body };
  try {
    const res = await postReceipt(req, deps);
    if (res.ok) {
      return { ok: true, status: res.status };
    }
    // Non-2xx: queue and notify (throttled).
    await enqueuePending(
      {
        endpoint,
        apiKey: config.apiKey,
        body,
        enqueuedAt: now(),
      },
      deps,
    );
    const cls = classifyError(null, res.status);
    await maybeNotify(
      cls,
      "Receipt POST failed (" + cls + "). Queued for retry.",
      deps,
    );
    return { ok: false, status: res.status, queued: true };
  } catch (err) {
    await enqueuePending(
      {
        endpoint,
        apiKey: config.apiKey,
        body,
        enqueuedAt: now(),
      },
      deps,
    );
    const cls = classifyError(err, undefined);
    await maybeNotify(
      cls,
      "Receipt POST failed (" + cls + "). Queued for retry.",
      deps,
    );
    return { ok: false, queued: true };
  }
}

/**
 * Drain the pending queue. Each entry is retried once per call; entries that
 * still fail go to the back of the queue. Bounded by PENDING_QUEUE_MAX so the
 * loop runs in O(n) per tick.
 *
 * @param {{ fetchImpl?: typeof fetch, now?: () => string, nowMs?: () => number }} [deps]
 * @returns {Promise<{ attempted: number, succeeded: number, remaining: number }>}
 */
async function drainPending(deps = {}) {
  const pending = await getPending();
  if (pending.length === 0) {
    return { attempted: 0, succeeded: 0, remaining: 0 };
  }
  const stillPending = [];
  let succeeded = 0;
  for (const entry of pending) {
    try {
      const res = await postReceipt(entry, deps);
      if (res.ok) {
        succeeded += 1;
      } else {
        stillPending.push(entry);
      }
    } catch (_err) {
      stillPending.push(entry);
    }
  }
  await setPending(stillPending);
  if (stillPending.length > 0) {
    await maybeNotify(
      "retry_partial",
      "Asqav retry queue still has " +
        stillPending.length +
        " pending receipt(s).",
      deps,
    );
  }
  return {
    attempted: pending.length,
    succeeded,
    remaining: stillPending.length,
  };
}

/**
 * Read chrome.storage.managed and, when mdmAutoEnable is true, auto-grant
 * optional host permissions for the managed host patterns, auto-enable
 * detection, and seed apiKey + agentId + endpoint overrides from the MDM
 * policy. Chrome auto-grants permission requests that originate from MDM
 * policy without prompting the user.
 *
 * Safe to call from chrome.runtime.onInstalled and chrome.runtime.onStartup.
 * No-ops gracefully when chrome.storage.managed is unavailable (e.g., in
 * unmanaged Chromium or in the Jest harness without an explicit mock).
 *
 * @param {{ permissionsRequestImpl?: Function }} [deps]
 * @returns {Promise<{ ran: boolean, granted?: boolean, hostsRequested?: number, endpointOverridden?: boolean }>}
 */
async function applyManagedPolicy(deps = {}) {
  if (
    !globalThis.chrome ||
    !chrome.storage ||
    !chrome.storage.managed ||
    typeof chrome.storage.managed.get !== "function"
  ) {
    return { ran: false };
  }
  let policy;
  try {
    policy = await chrome.storage.managed.get(MDM_KEYS);
  } catch (_err) {
    return { ran: false };
  }
  if (!policy || policy.mdmAutoEnable !== true) {
    return { ran: false };
  }

  // Seed credentials and endpoint overrides first so that any receipts
  // emitted before the permission grant resolves still use the right values.
  if (chrome.storage.session && chrome.storage.session.set && policy.mdmApiKey) {
    try {
      await chrome.storage.session.set({ apiKey: String(policy.mdmApiKey) });
    } catch (_err) {
      // best-effort
    }
  }
  if (policy.mdmApiEndpoint && typeof policy.mdmApiEndpoint === "string") {
    runtimeEndpointBase = policy.mdmApiEndpoint;
    try {
      await chrome.storage.local.set({
        apiEndpoint: policy.mdmApiEndpoint,
      });
    } catch (_err) {
      // best-effort
    }
  }
  try {
    await chrome.storage.local.set({ detectionEnabled: true });
  } catch (_err) {
    // best-effort
  }

  // Request the optional host permissions. MDM-policy-granted requests are
  // resolved without a user prompt by Chrome.
  const hosts = Array.isArray(policy.mdmManagedHosts)
    ? policy.mdmManagedHosts
    : AI_DOMAIN_SEED.map((h) => "https://" + h + "/*");
  let granted = false;
  let hostsRequested = hosts.length;
  if (chrome.permissions && chrome.permissions.request) {
    try {
      const requestImpl =
        deps.permissionsRequestImpl ||
        ((perms) =>
          new Promise((resolve) => {
            try {
              chrome.permissions.request(perms, (ok) => resolve(Boolean(ok)));
            } catch (_err) {
              resolve(false);
            }
          }));
      granted = await requestImpl({ origins: hosts });
    } catch (_err) {
      granted = false;
    }
  }
  return {
    ran: true,
    granted,
    hostsRequested,
    endpointOverridden: Boolean(policy.mdmApiEndpoint),
  };
}

/**
 * Register chrome.runtime.onInstalled and chrome.runtime.onStartup so the
 * MDM policy is applied whenever the extension boots.
 */
function registerManagedPolicyHooks() {
  if (!globalThis.chrome || !chrome.runtime) return;
  if (chrome.runtime.onInstalled && chrome.runtime.onInstalled.addListener) {
    chrome.runtime.onInstalled.addListener(() => {
      void applyManagedPolicy();
    });
  }
  if (chrome.runtime.onStartup && chrome.runtime.onStartup.addListener) {
    chrome.runtime.onStartup.addListener(() => {
      void applyManagedPolicy();
    });
  }
}

/**
 * Wire the chrome.tabs.onUpdated listener. Called once at service-worker
 * cold start.
 */
function registerTabListener() {
  if (!globalThis.chrome || !chrome.tabs || !chrome.tabs.onUpdated) return;
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, _tab) => {
    if (changeInfo.status !== "complete" || !changeInfo.url) {
      // Only act on commit so we do not double-fire on title or favicon updates.
      // changeInfo.url is populated when the URL field changes; pair with the
      // "complete" status so we capture once per navigation.
      if (!(changeInfo.status === "complete" && _tab && _tab.url)) {
        return;
      }
      void emitReceipt({ url: _tab.url, tabId });
      return;
    }
    void emitReceipt({ url: changeInfo.url, tabId });
  });
}

/**
 * Register the chrome.alarms tick that drains the retry queue every
 * RETRY_ALARM_MINUTES minutes. Also creates the alarm if it does not exist.
 */
function registerRetryAlarm() {
  if (!globalThis.chrome || !chrome.alarms) return;
  try {
    chrome.alarms.create(RETRY_ALARM_NAME, {
      periodInMinutes: RETRY_ALARM_MINUTES,
    });
  } catch (_err) {
    // alarms.create can throw in odd environments; the listener is the
    // important half.
  }
  if (chrome.alarms.onAlarm && chrome.alarms.onAlarm.addListener) {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm && alarm.name === RETRY_ALARM_NAME) {
        void drainPending();
      }
    });
  }
}

// Register on cold start. In Jest the chrome global is mocked, so these are
// safe calls even outside the browser.
registerTabListener();
registerRetryAlarm();
registerManagedPolicyHooks();
// Best-effort: apply the MDM policy immediately on cold start too, so a
// freshly installed managed device begins capturing on the first navigation
// rather than waiting for the next onStartup event.
void applyManagedPolicy();

// Test-only export. The MV3 service worker ignores module.exports but Jest
// (CommonJS) picks it up so the unit tests can drive the pure functions
// without standing up a full extension runtime.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    isAiDomain,
    buildReceiptBody,
    emitReceipt,
    jcsStringify,
    sha256Tag,
    registerTabListener,
    registerRetryAlarm,
    registerManagedPolicyHooks,
    applyManagedPolicy,
    enqueuePending,
    getPending,
    getArchive,
    getDropMetrics,
    setPending,
    drainPending,
    maybeNotify,
    classifyError,
    postReceipt,
    loadConfig,
    AI_DOMAIN_SEED,
    AI_DOMAIN_PATH_SCOPED,
    ASQAV_ENDPOINT_BASE,
    RECEIPT_TYPE,
    ACTION_TYPE,
    CAPTURE_TOPOLOGY,
    PENDING_QUEUE_KEY,
    PENDING_QUEUE_MAX,
    PENDING_ARCHIVE_KEY,
    PENDING_ARCHIVE_MAX,
    METRICS_DROPPED_KEY,
    METRICS_ARCHIVE_OVERFLOW_KEY,
    RETRY_ALARM_NAME,
    RETRY_ALARM_MINUTES,
    NOTIFY_THROTTLE_MS,
    NOTIFY_KEY,
    MDM_KEYS,
  };
}
