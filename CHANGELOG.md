# Changelog

All notable changes to the Asqav Shadow AI Capture browser extension are
documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `.github/workflows/forbidden-token-sweep.yml` gates PR title, body, and
  commit messages against the project token and pattern list
  (`.github/forbidden-tokens.txt`, `.github/forbidden-patterns.txt`).

### Changed

- Module-level JSDoc in `src/background.js` and `src/options.js` rewritten as
  present-tense contracts describing what the service worker and options
  controller do.

## [v0.1.0] - 2026-05-24

### Added

- Manifest V3 service worker that detects navigation to known AI provider
  domains.
- Receipt emission via POST to api.asqav.com with X-API-Key authentication.
- Retry queue (chrome.storage.local) with archival of overflowed entries
  (#2).
- chrome.storage.managed policy hook for MDM auto-enable (#2).
- 36 Jest unit tests; 2 Playwright e2e tests (#2).
- MDM deployment guides for Intune and JAMF (updated for
  optional_host_permissions, #2).

### Security

- optional_host_permissions migration: 28 AI hosts moved from install-time to
  runtime grant.
- apiKey now stored in chrome.storage.session (in-memory, cleared on browser
  restart); agentId and the retry queue remain in chrome.storage.local.

comment hygiene clean
