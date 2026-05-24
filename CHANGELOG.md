# Changelog

All notable changes to the Asqav Shadow AI Capture browser extension are
documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.1.0] - 2026-05-24

### Added

- Manifest V3 service worker that detects navigation to known AI provider
  domains.
- Receipt emission via POST to api.asqav.com with X-API-Key authentication.
- Retry queue (chrome.storage.session) with archival of dropped entries (this
  PR).
- chrome.storage.managed policy hook for MDM auto-enable (this PR).
- 36 Jest unit tests; 2 Playwright e2e tests (this PR).
- MDM deployment guides for Intune and JAMF (updated for
  optional_host_permissions, this PR).

### Security

- optional_host_permissions migration: 28 AI hosts moved from install-time to
  runtime grant.
- chrome.storage.session for ephemeral apiKey.

comment hygiene clean
