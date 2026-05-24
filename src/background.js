/**
 * Asqav Shadow AI Capture - service worker.
 *
 * Listens for tab navigation events, matches the destination host against the
 * Asqav AI-domain seed list, and emits an IETF-aligned compliance receipt to
 * the Asqav signer cloud. Metadata-only by default; the receipt body never
 * includes the prompt content.
 *
 * Endpoint: POST https://api.asqav.com/api/v1/agents/<agent_id>/sign
 * Auth:     X-API-Key header sourced from chrome.storage.local
 *
 * Cloud dependency: Track A1 (W1) must extend the receipt_type Literal in
 * SignRequest to include "protectmcp:observation" before posts from this
 * extension are accepted. Until then, the cloud returns invalid_receipt_type.
 */

const ASQAV_ENDPOINT_BASE = "https://api.asqav.com/api/v1/agents";
const RECEIPT_TYPE = "protectmcp:observation";
const ACTION_TYPE = "llm:egress";
const CAPTURE_TOPOLOGY = "browser_extension";

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
 * Fetch config from chrome.storage.local. Returns null when either field is
 * missing so callers can short-circuit before opening a network connection.
 *
 * @returns {Promise<{apiKey: string, agentId: string} | null>}
 */
async function loadConfig() {
  if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) {
    return null;
  }
  const { apiKey, agentId } = await chrome.storage.local.get([
    "apiKey",
    "agentId",
  ]);
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
 * Emit a receipt for one observed AI-tool navigation.
 *
 * @param {{ url: string, tabId: number }} navEvent
 * @param {{ fetchImpl?: typeof fetch, now?: () => string }} [deps]
 * @returns {Promise<{ ok: boolean, status?: number, skipped?: string }>}
 */
async function emitReceipt(navEvent, deps = {}) {
  if (!isAiDomain(navEvent.url)) {
    return { ok: false, skipped: "not_ai_domain" };
  }
  const config = await loadConfig();
  if (!config) {
    return { ok: false, skipped: "no_config" };
  }
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const now = deps.now || (() => new Date().toISOString());
  const domain = new URL(navEvent.url).hostname.toLowerCase();
  const userId = (await getProfileEmail()) || ("agent:" + config.agentId);
  const body = await buildReceiptBody({
    domain,
    tabSessionId: "tab:" + String(navEvent.tabId),
    observedAt: now(),
    userId,
  });
  const endpoint =
    ASQAV_ENDPOINT_BASE + "/" + encodeURIComponent(config.agentId) + "/sign";
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.apiKey,
    },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status };
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

// Register on cold start. In Jest the chrome global is mocked, so this is a
// safe call even outside the browser.
registerTabListener();

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
    AI_DOMAIN_SEED,
    AI_DOMAIN_PATH_SCOPED,
    ASQAV_ENDPOINT_BASE,
    RECEIPT_TYPE,
    ACTION_TYPE,
    CAPTURE_TOPOLOGY,
  };
}
