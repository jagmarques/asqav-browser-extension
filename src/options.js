/**
 * Asqav Shadow AI Capture - options page controller.
 *
 * Reads existing config out of chrome.storage.local, lets the operator set
 * the API key and synthetic agent ID, and persists on submit.
 */

(async () => {
  const form = document.getElementById("config-form");
  const apiKeyInput = document.getElementById("api-key");
  const agentIdInput = document.getElementById("agent-id");
  const statusEl = document.getElementById("status");

  const existing = await chrome.storage.local.get(["apiKey", "agentId"]);
  if (existing.apiKey) apiKeyInput.value = existing.apiKey;
  if (existing.agentId) agentIdInput.value = existing.agentId;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const apiKey = apiKeyInput.value.trim();
    const agentId = agentIdInput.value.trim();
    if (!apiKey || !agentId) {
      statusEl.textContent = "Both fields are required.";
      statusEl.style.color = "#a40000";
      return;
    }
    await chrome.storage.local.set({ apiKey, agentId });
    statusEl.textContent = "Saved.";
    statusEl.style.color = "#006400";
  });
})();
