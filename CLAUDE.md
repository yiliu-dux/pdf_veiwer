# CLAUDE.md

A Chromium extension that replaces the built-in PDF viewer with a pdf.js-based
one. See README.md for setup, tests, loading, and updating pdf.js.

## The core requirement

Scroll and zoom must respond to every input immediately: no dropped events, no
waiting on rendering. Rendering may lag behind (blank → low-res → full-res).
Every change must preserve this. In practice:

- **No heavy work on the viewer's main thread.** It handles input and places finished bitmaps, nothing else. Anything proportional to page count, or to page content, belongs in the worker or must run only for mounted pages while idle (never inside scroll/zoom handlers).
- **Scrolling is the browser's native root scroller.** Don't replace it with JS scrolling or a JS camera.
- **Zoom is applied synchronously in the wheel/key handler.** `PdfView.zoomTo` keeps the point under the cursor fixed. Don't debounce or defer it to rAF.
- **Only pages near the viewport have DOM nodes** (mount/unmount margins in `view.js`), so zoom costs the same for any page count.
- **The worker draws on CPU-backed canvases** (`willReadFrequently: true`). GPU-accelerated canvases stalled scrolling: the browser's single GPU process also composites, and one huge path is an uninterruptible task there. This was measured; don't "optimize" back to GPU canvases.
- Run `npm test` after changes. In the `bench` row for ours: wheel events seen must be 225/225, final scale must equal start scale, long tasks 0, frames > 50 ms 0.

## Architecture notes

- **Two threads plus pdf.js's own worker.** `main.js`/`view.js` run on the viewer page. `render-worker.js` is a module worker running pdf.js's *display* layer, which spawns pdf.js's parsing worker (`pdf.worker.mjs`) as a nested worker. The worker → view protocol is documented at the top of `render-worker.js`.
- **pdf.js in a worker** needs the stand-ins in `pdfjs-worker-env.js`: an OffscreenCanvas factory, a no-op SVG filter factory (rare effects such as transfer functions and knockout groups are skipped), `ownerDocument: { fonts: self.fonts }`, and `url` passed as a `URL` object (pdf.js resolves strings against `window.location`). These are the parts most likely to break on a pdf.js upgrade.
- **Cancellation:** pdf.js renders in ~15 ms chunks. `onContinue` yields via a MessageChannel so view/evict messages land mid-render and stale renders get cancelled. A single uninterruptible canvas operation can still take longer.
- **Takeover:** `contentscript.js` hides the browser's PDF document (closed shadow root on `<body>`) and puts our viewer in a full-size iframe, so the address bar shows the real URL. Earlier, every PDF was redirected to the extension page with declarativeNetRequest. That made the address bar show a `chrome-extension://` URL and left Vivaldi's progress bar stuck forever. DNR now only handles PDFs the browser would download (octet-stream). POST responses fall back to the built-in viewer, since the viewer must re-fetch with GET.
- **Security:** `viewer.html` is web-accessible, so any site can frame it. `main.js` refuses `file:` PDFs unless all ancestor origins are `file://`, and posts the title only to the PDF's own origin.
- **Test hooks:** `globalThis.viewerState()` and the `data-page`/`data-low`/`data-high` attributes on page divs are used by tests. Keep them.

## Next steps (agreed)

Reuse components from the `pdfjs-dist` components bundle (`node_modules/pdfjs-dist/web/pdf_viewer.mjs`: PDFFindController, PDFLinkService, TextLayerBuilder, …). Copy toolbar markup/CSS from `reference/pdf.js/web/` as owned code rather than adopting `app.js` (it is tightly coupled to pdf.js's own PDFViewer). Those components need a main-thread `PDFDocumentProxy`. The agreed plan is a second document instance on the main thread that never renders; text layers get built only for settled pages.

## Environment gotchas

- **Windows; the user browses in Vivaldi, not Chrome** (Chrome isn't installed). Behavior can differ: Vivaldi starts its built-in PDF viewer even when it is hidden (a one-time cost in a separate process).
- **Vivaldi under Puppeteer is flaky:** new tabs can be 0×0, and its UI doesn't update while the window is covered. Hence `tests/vivaldi-progress.mjs` is manual. The viewer itself handles 0×0 by deferring fit-to-width until it has a size.
- **Git Bash heredocs on this machine can collapse `\\`.** Write files containing backslashes (regexes, DNR rules) with an editor tool, not shell heredocs or sed.
- Node may not be on PATH in Git Bash: use `export PATH="/c/Program Files/nodejs:$PATH"`.
