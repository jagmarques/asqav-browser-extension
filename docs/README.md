# Asqav Shadow AI Capture

A Chromium MV3 extension that emits IETF-aligned compliance receipts to the
Asqav cloud whenever a managed user navigates to a known AI tool. Metadata-only
by default. The prompt body is never read in v0.

## Purpose

Give compliance, security, and IT teams a tamper-evident audit trail of AI tool
use across a managed Chromium fleet, without standing up a network proxy or
asking employees to install a heavy DLP agent. Each observation becomes a
signed receipt anchored against the same Asqav signer that handles
SDK-instrumented agents, so the audit pack is uniform across surfaces.

The receipt envelope conforms to the IETF Compliance Receipts -04 draft and
declares `capture_topology="browser_extension"` so the dashboard can render
shadow-AI provenance alongside SDK, MCP-proxy, and network-proxy traffic.

## Install (developer mode, v0)

1. Clone or download this repo.
2. Open `chrome://extensions` in Chrome, Edge, Brave, or Arc.
3. Toggle Developer mode (top right).
4. Click "Load unpacked" and choose the `asqav-browser-extension` folder.
5. The extension loads with the name "Asqav Shadow AI Capture".

## Configure

1. From `chrome://extensions`, click "Details" on the Asqav extension and open
   "Extension options".
2. Paste the API key issued by your Asqav admin. The key is stored in
   `chrome.storage.session` (in-memory, cleared on browser restart, not
   readable by other extensions). Re-enter after each browser restart.
3. Paste the synthetic agent ID provisioned for this device or user group.
   The agent id is stored in `chrome.storage.local` (persists; not secret).
4. Click Save.
5. Click "Enable Detection" to grant runtime host permissions for the AI-tool
   seed list (28 domains). Revocable any time via "Disable Detection".

Until both fields are present AND detection is enabled, the extension skips
all receipt emission.

## Reliability

Failed POSTs to `api.asqav.com` are queued in
`chrome.storage.local.pendingReceipts` (FIFO, capped at 100 entries) and
retried by a `chrome.alarms` tick every 5 minutes. The operator receives at
most one `chrome.notifications` toast per error class per hour so persistent
failures surface without spamming.

## Deploy at scale

- Intune (Windows-managed Chromium): see `docs/DEPLOY-INTUNE.md`.
- JAMF Pro (macOS Chromium): see `docs/DEPLOY-JAMF.md`.

The same `ExtensionInstallForcelist` policy mechanism applies to Google
Workspace and any other Chrome Enterprise console.

## Trust model

- v0 is metadata-only. The receipt body contains: domain, tab session id,
  observation timestamp, user id. Nothing from the page DOM is read.
- The hash field is a SHA-256 over the JCS-canonicalised context bag, not over
  the prompt content.
- All POSTs go to `https://api.asqav.com` over TLS with an `X-API-Key` header.
  No raw bodies are uploaded.

## AI domain seed list

`src/ai-domain-list.json` seeds the host_permissions and the runtime matcher.
Entries are derived from the Cloudflare AI Gateway public domain list and the
Push Security public shadow-AI tracker. Asqav adds, removes, or re-classifies
entries based on observed customer traffic patterns. Customers can fork the
list to add internal AI tools.

## Cloud dependency

Receipt POSTs from this extension use `receipt_type="protectmcp:observation"`.
The cloud SignRequest must accept that value before observations land
successfully end-to-end. That work is tracked as Asqav cloud Track A1 (W1):
extend the `receipt_type` Literal in `SignRequest` to include
`protectmcp:observation` and wire the audit-pack projection accordingly. Until
A1 merges, posts from this extension receive `invalid_receipt_type` and the
audit trail is local-only.

## Tests

```
npm install --save-dev jest
npm test
```

The Jest suite covers AI-domain detection, receipt body shape, and the
emit-vs-skip routing logic. WebCrypto SHA-256 hashing is exercised against the
Node 20+ `webcrypto` global.

## License

MIT. See `LICENSE` at the repo root.
