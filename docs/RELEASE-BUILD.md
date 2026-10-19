# Release build

Raw `src/` stays in git (reviewable). Only minified `dist/` ships.

- `npm run build` bundles `background.js` + `options.js` with esbuild
  (minify, no legal comments, no source maps) into `dist/` (gitignored).
- `manifest.json` loads the service worker from `dist/`; the options
  page loads `../dist/options.js`. `content.js` is an unreferenced
  placeholder and is intentionally not bundled.
- `tests/build-artifacts.test.js` fails on any `.map`, private-host
  string, or secret-shaped literal in `dist/`, with planted controls.
- Store zip: `manifest.json`, `src/options.html`, `dist/`, `icons/`,
  `managed_schema.json`. Build it from a clean checkout after CI.
