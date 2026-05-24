# asqav-browser-extension

Chromium MV3 extension that emits IETF-aligned compliance receipts for AI tool
use observed in the browser.

See [`docs/README.md`](docs/README.md) for purpose, install, configure, deploy,
and trust-model documentation.

Deployment guides:

- [`docs/DEPLOY-INTUNE.md`](docs/DEPLOY-INTUNE.md)
- [`docs/DEPLOY-JAMF.md`](docs/DEPLOY-JAMF.md)

## Permission model

Install-time permissions (required for the extension to load):

- `tabs`, `storage`, `declarativeNetRequest`, `alarms`, `notifications`
- `host_permissions`: only `https://api.asqav.com/*` (the signer endpoint)

Runtime permissions (granted by the operator from the options page):

- `optional_host_permissions`: 28 AI-tool domains (OpenAI, Anthropic, Google,
  Microsoft, Perplexity, Mistral, Cohere, HuggingFace, etc.). Granted in one
  click via "Enable Detection" on the options page. Revocable any time via
  "Disable Detection".

This split removes the install-time "this extension can read and change all
your data on N sites" warning in Chrome Web Store and avoids the broad-host
review flag.

## Credential storage

- `apiKey` is stored in `chrome.storage.session` (in-memory, cleared on
  browser restart, not readable by other extensions with the `storage`
  permission). Re-enter after each browser restart.
- `agentId` is stored in `chrome.storage.local` (persists across restarts;
  not secret).

If `chrome.storage.session` is unavailable (very old Chromium), the apiKey
falls back to `chrome.storage.local` with a note on the options page.

## Reliability

Failed POSTs to `api.asqav.com` are queued in
`chrome.storage.local.pendingReceipts` (FIFO, capped at 100 entries) and
retried by a `chrome.alarms` tick every 5 minutes. The operator receives at
most one `chrome.notifications` toast per error class per hour so persistent
failures surface without spamming.

License: MIT.

comment hygiene clean
