# Smooth PDF Viewer (Chromium extension)

Replaces the built-in PDF viewer of Chrome and other Chromium browsers
(Vivaldi, Edge, …) with one built on [pdf.js](https://github.com/mozilla/pdf.js),
designed so scrolling and zooming never wait on rendering: input is applied
immediately, and rendering catches up (blank → low-res → full-res).

## Setup

Requirements: [Node.js](https://nodejs.org/) LTS (includes npm) and git. On
Windows, for example: `winget install OpenJS.NodeJS.LTS`.

```sh
npm install
```

This installs dev dependencies (Puppeteer downloads its own Chrome for
Testing) and copies the pinned pdf.js into `extension/lib/pdfjs/`
(`npm run sync-pdfjs` does the copy on its own).

Optional, for the benchmark's stock-viewer comparison and for reading pdf.js
source:

```sh
npm run fetch-reference
```

This downloads the matching pdf.js release (`reference/pdfjs-dist/`) and
source (`reference/pdf.js/`).

## Build and load

There is no build step: `extension/` is the unpacked extension.

1. Open `chrome://extensions` (or `vivaldi://extensions`, `edge://extensions`), enable **Developer mode**, click **Load unpacked**, and pick `extension/`.
2. For local PDFs, open the extension's **Details** and enable **Allow access to file URLs** (one time).
3. After changing code, click the extension's reload button and reload open PDF tabs.

To package a `.zip` for a store, zip the contents of `extension/` after `npm install`.

## Tests

```sh
npm test
```

Runs headless in Chrome for Testing:

- **smoke**: a PDF opens in the extension, renders, and stays sharp when zoomed to 900%.
- **local-file**: `file://` PDFs open and render.
- **iframe**: PDFs inside iframes open and render.
- **tab-status**: the tab finishes loading.
- **zoom-anchor**: the point under the cursor stays fixed during a pinch.
- **bench**: sends 225 wheel events while a 2,000-page, very heavy PDF renders, and checks that every event was applied and the final zoom is exact. Compares against the stock pdf.js viewer if `npm run fetch-reference` was run.

Single checks run with `node tests/<name>.mjs`. The heavy test PDF is generated on first run.

`node tests/vivaldi-progress.mjs` checks that Vivaldi's address-bar progress finishes (it got stuck with the old redirect-based takeover). Run it by hand with the test window visible, because Vivaldi's UI stops updating while covered. To run another check in a different Chromium build, set `BROWSER=<path to browser exe>`.

## Updating pdf.js

pdf.js comes from the [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist) npm package, pinned to an exact version:

```sh
npm install --save-dev --save-exact pdfjs-dist@<version>   # also re-copies into extension/lib
npm test
npm run fetch-reference   # optional: matching stock viewer and source
```

If something breaks, look first at `extension/viewer/pdfjs-worker-env.js`. It depends on pdf.js internals (how it uses the DOM for canvases, fonts and filters) so that pdf.js can render inside a worker. Compare against `src/display/api.js`, `canvas_factory.js`, `filter_factory.js` and `font_loader.js` in the new source.

## Layout

- `extension/manifest.json`: Manifest V3.
- `extension/contentscript.js`: covers the browser's own PDF document with our viewer in an iframe, so the address bar keeps the real URL.
- `extension/background.js`: redirects PDFs the browser would download instead of display (wrong MIME type) and local files without file access, and tells the content script about POST responses. Adapted from Mozilla's Chromium extension.
- `extension/viewer/`: the viewer page.
  - `main.js`: entry point. Decides which PDF to open, handles file access and the tab title, and connects the worker to the view.
  - `view.js`: main thread. Scroll position, zoom, mounting pages near the viewport, placing rendered bitmaps. No rendering.
  - `layout.js`: page geometry (pure).
  - `render-worker.js`: decides what to render next and rasterizes it, off the main thread. Its message protocol is documented at the top.
  - `pdfjs-worker-env.js`: stand-ins that let pdf.js render without a DOM.
- `extension/lib/pdfjs/`: pdf.js, copied from `node_modules` (git-ignored).
- `scripts/`: `sync-pdfjs.mjs` and `fetch-reference.mjs`.
- `tests/`: Puppeteer checks; `harness.mjs` holds the shared setup.
