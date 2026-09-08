// Asqav Browser Capture service worker: navigation receipts and retries

const ASQAV_ENDPOINT_BASE = "https://api.asqav.com/api/v1/agents";
const RECEIPT_TYPE = "protectmcp:observation";
const ACTION_TYPE = "llm:egress";
const CAPTURE_TOPOLOGY = "browser_extension";

// Retry queue knobs
const PENDING_QUEUE_KEY = "pendingReceipts";
const PENDING_QUEUE_MAX = 100;
const PENDING_ARCHIVE_KEY = "pendingReceiptsArchive";
const PENDING_ARCHIVE_MAX = 1000;
const METRICS_DROPPED_KEY = "metricsReceiptsDropped";
const METRICS_ARCHIVE_OVERFLOW_KEY = "metricsArchiveOverflow";
const RETRY_ALARM_NAME = "asqav-retry-pending";
const RETRY_ALARM_MINUTES = 5;

// Notification timestamps are stored per error class in storage.local

const NOTIFY_THROTTLE_MS = 60 * 60 * 1000;
const NOTIFY_KEY = "errorNotifiedAt";

// MDM policy keys read from chrome.storage.managed
const MDM_KEYS = [
  "mdmAutoEnable",
  "mdmApiKey",
  "mdmApiEndpoint",
  "mdmManagedHosts",
];

// Managed endpoint base for new receipt requests

let runtimeEndpointBase = ASQAV_ENDPOINT_BASE;

// Keep the host seed available during service-worker cold starts

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

// Match only the listed URL prefixes on hosts with scoped AI tools

const AI_DOMAIN_PATH_SCOPED = {
  "github.com": ["/copilot"],
};

// Match known AI hosts and their scoped paths
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

// Canonicalize the context fields before hashing
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

// Hash UTF-8 text with WebCrypto and return a sha256-prefixed hex digest
async function sha256Tag(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return "sha256:" + hex;
}

// Hash the context and return the receipt request body
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

// Read the key and agent ID; return null when either is absent
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
  // Fall back to the local key when the session key is unavailable

  if (!apiKey) {
    const localPart = await chrome.storage.local.get(["apiKey"]);
    apiKey = localPart.apiKey;
  }
  if (!apiKey || !agentId) return null;
  return { apiKey, agentId };
}

// Return the browser profile email, or an empty string when unavailable
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

// Append a failed receipt and account for queue and archive overflow
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

  // Queue transport fields without the API key; retries read the key again

  existing.push({
    endpoint: entry.endpoint,
    body: entry.body,
    enqueuedAt: entry.enqueuedAt,
  });
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
    // Structured event for SOC log scrapers tailing the service-worker console
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

// Replace the stored pending queue
async function setPending(entries) {
  if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) return;
  await chrome.storage.local.set({ [PENDING_QUEUE_KEY]: entries });
}

// Return the pending queue, or an empty array
async function getPending() {
  if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) return [];
  const { [PENDING_QUEUE_KEY]: existing = [] } = await chrome.storage.local.get(
    [PENDING_QUEUE_KEY],
  );
  return Array.isArray(existing) ? existing : [];
}

// Return archived overflow entries, or an empty array
async function getArchive() {
  if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) return [];
  const { [PENDING_ARCHIVE_KEY]: existing = [] } =
    await chrome.storage.local.get([PENDING_ARCHIVE_KEY]);
  return Array.isArray(existing) ? existing : [];
}

// Read drop counters and queue sizes for the options page
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

// Throttle best-effort notifications by error class
async function maybeNotify(errorClass, message, deps = {}) {
  if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) return;
  const nowMs = deps.nowMs || (() => Date.now());
  const { [NOTIFY_KEY]: book = {} } = await chrome.storage.local.get([
    NOTIFY_KEY,
  ]);
  const lastAt = (book && book[errorClass]) || 0;
  const now = nowMs();
  // lastAt === 0 means we have never fired for this class; allow through
  if (lastAt !== 0 && now - lastAt < NOTIFY_THROTTLE_MS) return;
  const nextBook = Object.assign({}, book, { [errorClass]: now });
  await chrome.storage.local.set({ [NOTIFY_KEY]: nextBook });
  if (chrome.notifications && chrome.notifications.create) {
    try {
      chrome.notifications.create("", {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Asqav Browser Capture",
        message,
        priority: 0,
      });
    } catch (_err) {
      // best-effort
    }
  }
}

// Classify HTTP and transport failures for notification throttling
function classifyError(err, status) {
  if (status && status >= 500) return "server_5xx";
  if (status && status >= 400) return "client_4xx";
  if (err && typeof err === "object" && err.name === "AbortError") {
    return "abort";
  }
  return "network";
}

// POST a receipt; return HTTP status or throw on transport failure
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

// Sign an AI navigation receipt; queue and notify on failure
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
    // Non-2xx: queue and notify (throttled)
    await enqueuePending(
      {
        endpoint,
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

// Retry the pending snapshot and retain entries that still fail
async function drainPending(deps = {}) {
  const pending = await getPending();
  if (pending.length === 0) {
    return { attempted: 0, succeeded: 0, remaining: 0 };
  }
  // Read the key again; queue entries never contain credentials
  // Hold the queue when configuration is incomplete
  const config = await loadConfig();
  if (!config) {
    await maybeNotify(
      "retry_no_key",
      "Asqav retry queue held: API key unavailable until re-entered in options.",
      deps,
    );
    return {
      attempted: 0,
      succeeded: 0,
      remaining: pending.length,
      held: true,
    };
  }
  const stillPending = [];
  let succeeded = 0;
  for (const entry of pending) {
    try {
      const res = await postReceipt({ ...entry, apiKey: config.apiKey }, deps);
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

// Apply managed key and endpoint settings, then request host permissions
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

  // Store the managed key and endpoint before requesting permissions

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

  // Request host access; managed settings do not establish a grant

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

// Apply managed settings on install and browser startup
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

// Register the completed-navigation listener at worker startup
function registerTabListener() {
  if (!globalThis.chrome || !chrome.tabs || !chrome.tabs.onUpdated) return;
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, _tab) => {
    if (changeInfo.status !== "complete" || !changeInfo.url) {
      // Use the changed URL or the completed tab URL
      if (!(changeInfo.status === "complete" && _tab && _tab.url)) {
        return;
      }
      void emitReceipt({ url: _tab.url, tabId });
      return;
    }
    void emitReceipt({ url: changeInfo.url, tabId });
  });
}

// Register and create the periodic retry alarm
function registerRetryAlarm() {
  if (!globalThis.chrome || !chrome.alarms) return;
  try {
    chrome.alarms.create(RETRY_ALARM_NAME, {
      periodInMinutes: RETRY_ALARM_MINUTES,
    });
  } catch (_err) {
    // Retain the listener if alarm creation fails

  }
  if (chrome.alarms.onAlarm && chrome.alarms.onAlarm.addListener) {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm && alarm.name === RETRY_ALARM_NAME) {
        void drainPending();
      }
    });
  }
}

// Register listeners when the worker module loads

registerTabListener();
registerRetryAlarm();
registerManagedPolicyHooks();
// Attempt managed setup when the worker module loads
void applyManagedPolicy();

// Expose test helpers only when CommonJS is available
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
