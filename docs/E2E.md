# Running the Playwright e2e suite locally

The Jest unit suite drives the pure functions of `src/background.js` against a
mocked `chrome.*` surface in under a second. The Playwright suite covers the
"does the bundle actually load in a real Chromium" gap by booting an unpacked
extension in a persistent Chromium context and asserting the service worker
registers and emits a POST.

## One-time setup

```
npm install
npx playwright install --with-deps chromium
```

The second command pulls the full Chromium build (about 170 MB). The smaller
headless shell that ships by default with Playwright does not support MV3
extensions; full Chromium is required.

## Run

```
npm run test:e2e
```

Expected output:

```
Running 2 tests using 1 worker
  ok  1 tests/e2e/extension.spec.js:.. > extension bundle loads and service worker is reachable
  ok  2 tests/e2e/extension.spec.js:.. > AI host navigation triggers a sign() POST to api.asqav.com
  2 passed
```

## What the tests assert

1. After `--load-extension=<repo>` Chromium registers a service worker whose
   URL matches `chrome-extension://<32-char-id>/src/background.js`. This
   proves the manifest, icons, and background bundle all parse and load.
2. When the worker is seeded with an apiKey + agentId and granted runtime
   permission for `https://chat.openai.com/*`, a POST to
   `https://api.asqav.com/api/v1/agents/e2e-agent/sign` carries the expected
   `X-API-Key` header and is intercepted by the Playwright route handler
   before leaving the box. No real network traffic is sent.

## CI

`.github/workflows/ci.yml` runs the Jest suite and the Playwright e2e suite
as two separate jobs. The Playwright job installs Chromium on the runner
before invoking `npm run test:e2e`.
