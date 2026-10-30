// Input-responsiveness benchmark. Drives real (CDP-dispatched) wheel input
// while pages are rendering and reports:
//   - input delay: wheel event timestamp -> main-thread dispatch
//   - main-thread frame gaps (rAF) and long tasks
//   - correctness: final scroll offset / scale vs. what the input asked for
//
// Usage: node tests/bench.mjs [ours|stock|both] [fixture.pdf]

import { existsSync } from "node:fs";
import { launch, openPdf, startServer } from "./harness.mjs";

const which = process.argv[2] ?? "both";
const fixture = process.argv[3] ?? "heavy.pdf";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const INSTRUMENT = () => {
  const m = (window.__m = { delays: [], frames: [], longtasks: 0, longtaskMs: 0 });
  addEventListener(
    "wheel",
    e => m.delays.push(performance.now() - e.timeStamp),
    { capture: true, passive: true }
  );
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      m.longtasks++;
      m.longtaskMs += e.duration;
    }
  }).observe({ type: "longtask" });
  let last = performance.now();
  const frame = t => {
    m.frames.push(t - last);
    last = t;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window.__reset = () => {
    m.delays.length = m.frames.length = 0;
    m.longtasks = m.longtaskMs = 0;
  };
};

const VIEWERS = {
  ours: {
    url: base => base + fixture,
    ready: () => document.querySelector(".page[data-high]") !== null,
    state: () => globalThis.viewerState(),
  },
  stock: {
    url: base => `${base}stock/web/viewer.html?file=/${fixture}`,
    ready: () => document.querySelector(".page[data-loaded] canvas") !== null,
    state: () => ({
      scale: PDFViewerApplication.pdfViewer.currentScale,
      scrollTop: document.getElementById("viewerContainer").scrollTop,
    }),
  },
};

function pct(arr, p) {
  if (!arr.length) {
    return 0;
  }
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function run(name, base) {
  const v = VIEWERS[name];
  const browser = await launch();
  const page = await browser.newPage();
  // Ours runs in an iframe (a separate target), so instrument it once open.
  let target;
  if (name === "ours") {
    target = await openPdf(page, v.url(base));
    await target.waitForFunction(v.ready, { timeout: 30000 });
    await target.evaluate(INSTRUMENT);
  } else {
    await page.evaluateOnNewDocument(INSTRUMENT);
    await page.goto(v.url(base));
    target = page.mainFrame();
    await target.waitForFunction(v.ready, { timeout: 30000 });
  }
  await sleep(300);
  const cdp = await page.createCDPSession();
  const x = 640;
  const y = 400;
  const wheel = (deltaY, modifiers = 0) =>
    cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers,
    });

  // Fire input on a fixed 60 Hz clock without waiting for acks, like a real
  // device would.
  async function drive(events) {
    const pending = [];
    for (const [deltaY, modifiers] of events) {
      pending.push(wheel(deltaY, modifiers));
      await sleep(16);
    }
    await Promise.all(pending);
  }

  const s0 = await target.evaluate(v.state);
  await target.evaluate(() => window.__reset());

  // Phase 1: scroll down through freshly-rendering pages.
  const SCROLL_EVENTS = 90;
  await drive(Array.from({ length: SCROLL_EVENTS }, () => [100, 0]));
  await sleep(800);
  const s1 = await target.evaluate(v.state);

  // Phase 2: pinch-zoom in (ctrl+wheel, small deltas), then zoom out while
  // interleaving scroll events. Net zoom is zero, so the final scale must
  // equal the starting scale if no zoom input was dropped.
  const ZOOM_EVENTS = 60;
  const CTRL = 2;
  const zoom = [];
  for (let i = 0; i < ZOOM_EVENTS; i++) {
    zoom.push([-2, CTRL]);
  }
  for (let i = 0; i < ZOOM_EVENTS; i++) {
    zoom.push([2, CTRL]);
    if (i % 4 === 0) {
      zoom.push([40, 0]);
    }
  }
  await drive(zoom);
  await sleep(1500);
  const s2 = await target.evaluate(v.state);

  const m = await target.evaluate(() => window.__m);
  await browser.close();

  const frames = m.frames.slice(1);
  return {
    viewer: name,
    "input delay p50 (ms)": +pct(m.delays, 50).toFixed(1),
    "input delay p95 (ms)": +pct(m.delays, 95).toFixed(1),
    "input delay max (ms)": +Math.max(0, ...m.delays).toFixed(1),
    "wheel events seen": m.delays.length,
    "frame gap p95 (ms)": +pct(frames, 95).toFixed(1),
    "frame gap max (ms)": +Math.max(0, ...frames).toFixed(1),
    "frames > 50ms": frames.filter(f => f > 50).length,
    "long tasks": m.longtasks,
    "long task total (ms)": Math.round(m.longtaskMs),
    "scrolled (px)": Math.round(s1.scrollTop - s0.scrollTop),
    "scale start": +s0.scale.toFixed(4),
    "scale end": +s2.scale.toFixed(4),
  };
}

const { server, base } = await startServer();
const results = [];
const hasStock = existsSync("reference/pdfjs-dist/web/viewer.html");
if (!hasStock && which !== "ours") {
  console.log("Stock viewer missing (run `npm run fetch-reference`); benchmarking ours only.");
}
for (const name of which === "both" ? (hasStock ? ["ours", "stock"] : ["ours"]) : [which]) {
  results.push(await run(name, base));
}
server.close();
console.table(Object.fromEntries(results.map(r => [r.viewer, r])));
