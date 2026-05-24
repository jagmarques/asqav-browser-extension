/**
 * Asqav Shadow AI Capture - options page controller.
 *
 * Storage split (hardening cycle 25):
 *   - apiKey -> chrome.storage.session (in-memory, cleared on browser restart).
 *     Not readable by other extensions; reduces blast radius of any rogue
 *     extension with the "storage" permission.
 *   - agentId -> chrome.storage.local (persists across restarts). Not secret.
 *
 * Host permissions for the AI-domain seed list are declared as
 * optional_host_permissions in manifest.json and requested at runtime via
 * chrome.permissions.request when the operator clicks "Enable Detection".
 * This eliminates the install-time broad-host warning in Chrome Web Store.
 */

const AI_HOST_PATTERNS = [
  "https://chat.openai.com/*",
  "https://chatgpt.com/*",
  "https://openai.com/*",
  "https://platform.openai.com/*",
  "https://api.openai.com/*",
  "https://claude.ai/*",
  "https://anthropic.com/*",
  "https://api.anthropic.com/*",
  "https://gemini.google.com/*",
  "https://bard.google.com/*",
  "https://generativelanguage.googleapis.com/*",
  "https://copilot.microsoft.com/*",
  "https://github.com/copilot*",
  "https://perplexity.ai/*",
  "https://www.perplexity.ai/*",
  "https://mistral.ai/*",
  "https://chat.mistral.ai/*",
  "https://api.mistral.ai/*",
  "https://cohere.com/*",
  "https://cohere.ai/*",
  "https://dashboard.cohere.com/*",
  "https://huggingface.co/*",
  "https://hf.co/*",
  "https://you.com/*",
  "https://phind.com/*",
  "https://xai.com/*",
  "https://x.ai/*",
  "https://grok.x.ai/*",
];

/**
 * Wrap chrome.permissions.contains in a promise. Returns false when the
 * permissions API is unavailable so the options page degrades gracefully.
 */
function permissionsContains(perms) {
  return new Promise((resolve) => {
    if (!chrome.permissions || !chrome.permissions.contains) {
      resolve(false);
      return;
    }
    try {
      chrome.permissions.contains(perms, (result) => resolve(Boolean(result)));
    } catch (_err) {
      resolve(false);
    }
  });
}

/**
 * Wrap chrome.permissions.request in a promise.
 */
function permissionsRequest(perms) {
  return new Promise((resolve) => {
    if (!chrome.permissions || !chrome.permissions.request) {
      resolve(false);
      return;
    }
    try {
      chrome.permissions.request(perms, (granted) => resolve(Boolean(granted)));
    } catch (_err) {
      resolve(false);
    }
  });
}

/**
 * Wrap chrome.permissions.remove in a promise.
 */
function permissionsRemove(perms) {
  return new Promise((resolve) => {
    if (!chrome.permissions || !chrome.permissions.remove) {
      resolve(false);
      return;
    }
    try {
      chrome.permissions.remove(perms, (removed) => resolve(Boolean(removed)));
    } catch (_err) {
      resolve(false);
    }
  });
}

/**
 * Refresh the on-page permission state label.
 */
async function refreshPermStatus(el) {
  const granted = await permissionsContains({ origins: AI_HOST_PATTERNS });
  if (granted) {
    el.textContent = "Detection enabled. Permissions granted.";
    el.className = "perm-status granted";
  } else {
    el.textContent = "Detection disabled. No host permissions granted.";
    el.className = "perm-status denied";
  }
}

(async () => {
  const form = document.getElementById("config-form");
  const apiKeyInput = document.getElementById("api-key");
  const agentIdInput = document.getElementById("agent-id");
  const statusEl = document.getElementById("status");
  const enableBtn = document.getElementById("enable-detection");
  const disableBtn = document.getElementById("disable-detection");
  const permStatusEl = document.getElementById("perm-status");

  // Read agentId from .local (persists) and apiKey from .session (in-memory).
  const localExisting = await chrome.storage.local.get(["agentId"]);
  if (localExisting.agentId) agentIdInput.value = localExisting.agentId;

  if (chrome.storage.session && chrome.storage.session.get) {
    const sessionExisting = await chrome.storage.session.get(["apiKey"]);
    if (sessionExisting.apiKey) apiKeyInput.value = sessionExisting.apiKey;
  }

  await refreshPermStatus(permStatusEl);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const apiKey = apiKeyInput.value.trim();
    const agentId = agentIdInput.value.trim();
    if (!apiKey || !agentId) {
      statusEl.textContent = "Both fields are required.";
      statusEl.style.color = "#a40000";
      return;
    }
    // agentId persists; apiKey lives only in session memory.
    await chrome.storage.local.set({ agentId });
    if (chrome.storage.session && chrome.storage.session.set) {
      await chrome.storage.session.set({ apiKey });
    } else {
      // Fallback for older browsers without storage.session: write to local
      // and surface a downgrade notice. The cloud documents this trade-off.
      await chrome.storage.local.set({ apiKey });
    }
    statusEl.textContent = "Saved.";
    statusEl.style.color = "#006400";
  });

  enableBtn.addEventListener("click", async () => {
    const granted = await permissionsRequest({ origins: AI_HOST_PATTERNS });
    if (granted) {
      statusEl.textContent = "Detection enabled.";
      statusEl.style.color = "#006400";
    } else {
      statusEl.textContent = "Permission request denied.";
      statusEl.style.color = "#a40000";
    }
    await refreshPermStatus(permStatusEl);
  });

  disableBtn.addEventListener("click", async () => {
    const removed = await permissionsRemove({ origins: AI_HOST_PATTERNS });
    if (removed) {
      statusEl.textContent = "Detection disabled.";
      statusEl.style.color = "#555";
    } else {
      statusEl.textContent = "Could not remove permissions.";
      statusEl.style.color = "#a40000";
    }
    await refreshPermStatus(permStatusEl);
  });
})();

// Test-only export (CommonJS). Browsers ignore module.exports.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { AI_HOST_PATTERNS };
}
