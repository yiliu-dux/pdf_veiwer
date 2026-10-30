// Render worker: owns the pdf.js document and rasterizes off the main thread.
//
// Messages in:
//   open  { url } | { data }   load a document; replies "doc" { sizes, title }
//   view  { scale, dpr, visible, near }   what's on screen, by priority; each
//         entry is { p, vis } with vis = visible part (page fractions) or null
//   evict { pages }   the view dropped these pages and their bitmaps
// Messages out:
//   bitmap { p, kind: "low" | "high", rect, bitmap }   rect in page fractions
//
// Each page gets a quick low-res pass, then a full-res one (the whole page, or
// a tile around the visible part when zoomed far in). Renders that stop being
// wanted are cancelled between pdf.js's ~15 ms chunks.

import { createCanvas, openDocument, RenderingCancelledException } from "./pdfjs-worker-env.js";

const PDF_TO_CSS = 96 / 72;
const LOW_SCALE = 0.25; // CSS scale of the low-res pass (letter page ≈ 204 px wide)
// Beyond this a page is rendered as a tile instead of whole; also keeps us
// under the browser's canvas limits.
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_DIM = 8192;
// Full-res renders wait until the scale has been stable this long, so a zoom
// gesture doesn't start and discard a render per frame.
const SETTLE_MS = 150;
const FULL = { x0: 0, y0: 0, x1: 1, y1: 1 };

let doc = null;
let sizes = null; // [w0, h0, w1, h1, ...] in CSS px at scale 1
const pages = [];
let view = null;
let lastScaleChange = 0;
// What the view holds per page: { low: bool, high: { res, rect } | null }.
// Evicting deletes the entry, which also invalidates renders in flight.
const held = new Map();
let current = null;
let pumpQueued = false;
let settleTimer = 0;

self.onmessage = ({ data: msg }) => {
  switch (msg.type) {
    case "open":
      open(msg).catch(e => postMessage({ type: "error", message: String(e?.message ?? e) }));
      return;
    case "view":
      if (msg.scale !== view?.scale || msg.dpr !== view?.dpr) {
        lastScaleChange = performance.now();
      }
      view = msg;
      break;
    case "evict":
      for (const p of msg.pages) {
        held.delete(p);
        pages[p]?.then(page => page.cleanup());
      }
      break;
  }
  schedulePump();
};

async function open(source) {
  doc = await openDocument(source);
  const all = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => getPage(i)));
  sizes = new Float64Array(all.length * 2);
  for (const [i, page] of all.entries()) {
    const { width, height } = page.getViewport({ scale: PDF_TO_CSS });
    sizes[2 * i] = width;
    sizes[2 * i + 1] = height;
  }
  const title = (await doc.getMetadata().catch(() => null))?.info?.Title;
  postMessage({ type: "doc", sizes, title });
  schedulePump();
}

function getPage(i) {
  return (pages[i] ??= doc.getPage(i + 1));
}

// Deferred so a burst of queued view/evict messages is planned once.
function schedulePump() {
  if (!pumpQueued) {
    pumpQueued = true;
    setTimeout(pump, 0);
  }
}

function pump() {
  pumpQueued = false;
  if (!sizes || !view) {
    return;
  }
  const wanted = plan();
  if (current && !wanted.some(j => j.key === current.key)) {
    current.cancelled = true;
    current.task?.cancel(); // run() pumps again once the cancel lands.
  } else if (!current && wanted.length) {
    run(wanted[0]);
  }
}

// Wanted renders, most urgent first: visible pages before nearby ones, and
// within each, low-res passes before full-res ones.
function plan() {
  const sinceScale = performance.now() - lastScaleChange;
  const settling = sinceScale < SETTLE_MS;
  if (settling) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(schedulePump, SETTLE_MS - sinceScale + 1);
  }
  const res = view.scale * view.dpr;
  const jobs = [];
  for (const group of [view.visible, view.near]) {
    for (const { p } of group) {
      if (!held.get(p)?.low) {
        jobs.push(job(p, "low", LOW_SCALE * view.dpr, FULL));
      }
    }
    if (settling) {
      continue;
    }
    for (const { p, vis } of group) {
      const rect = highRect(p, res, vis);
      if (rect && !hasHigh(p, res, vis ?? FULL)) {
        jobs.push(job(p, "high", res, rect));
      }
    }
  }
  return jobs;
}

function job(p, kind, res, rect) {
  const key = `${kind}:${p}:${res}:${rect.x0},${rect.y0},${rect.x1},${rect.y1}`;
  return { key, p, kind, res, rect, task: null, cancelled: false };
}

function hasHigh(p, res, need) {
  const high = held.get(p)?.high;
  return (
    !!high &&
    Math.abs(high.res / res - 1) < 1e-3 &&
    high.rect.x0 <= need.x0 + 1e-6 &&
    high.rect.y0 <= need.y0 + 1e-6 &&
    high.rect.x1 >= need.x1 - 1e-6 &&
    high.rect.y1 >= need.y1 - 1e-6
  );
}

function fits(w, h) {
  return w * h <= MAX_PIXELS && w <= MAX_DIM && h <= MAX_DIM;
}

// The whole page if it fits the pixel budget, otherwise a tile around the
// visible part (or null for an off-screen page).
function highRect(p, res, vis) {
  const fullW = sizes[2 * p] * res;
  const fullH = sizes[2 * p + 1] * res;
  if (fits(fullW, fullH)) {
    return FULL;
  }
  if (!vis) {
    return null;
  }
  const w = vis.x1 - vis.x0;
  const h = vis.y1 - vis.y0;
  for (const margin of [0.5, 0.25]) {
    const r = {
      x0: Math.max(0, vis.x0 - w * margin),
      y0: Math.max(0, vis.y0 - h * margin),
      x1: Math.min(1, vis.x1 + w * margin),
      y1: Math.min(1, vis.y1 + h * margin),
    };
    if (fits((r.x1 - r.x0) * fullW, (r.y1 - r.y0) * fullH)) {
      return r;
    }
  }
  return vis;
}

// Yield to the event loop between render chunks so view/evict messages land
// (and stale renders get cancelled) mid-render. A MessageChannel avoids
// setTimeout's nested-call clamping.
const yieldChannel = new MessageChannel();
const yieldQueue = [];
yieldChannel.port1.onmessage = () => yieldQueue.shift()();
function yieldThen(cont) {
  yieldQueue.push(cont);
  yieldChannel.port2.postMessage(0);
}

async function run(j) {
  current = j;
  if (!held.has(j.p)) {
    held.set(j.p, { low: false, high: null });
  }
  const entry = held.get(j.p);
  try {
    const page = await getPage(j.p);
    if (j.cancelled) {
      return;
    }
    const vp = page.getViewport({ scale: j.res * PDF_TO_CSS });
    const x = Math.floor(j.rect.x0 * vp.width);
    const y = Math.floor(j.rect.y0 * vp.height);
    const w = Math.max(1, Math.ceil(j.rect.x1 * vp.width) - x);
    const h = Math.max(1, Math.ceil(j.rect.y1 * vp.height) - y);
    const { canvas, context } = createCanvas(w, h);
    j.task = page.render({
      canvasContext: context,
      viewport: vp,
      transform: [1, 0, 0, 1, -x, -y],
      background: "white",
    });
    j.task.onContinue = yieldThen;
    await j.task.promise;
    if (j.cancelled || held.get(j.p) !== entry) {
      return; // Unwanted, or the page was evicted meanwhile.
    }
    if (j.kind === "low") {
      entry.low = true;
    } else {
      // The requested rect; the pixel-snapped one sent below covers it.
      entry.high = { res: j.res, rect: j.rect };
    }
    const rect = { x0: x / vp.width, y0: y / vp.height, x1: (x + w) / vp.width, y1: (y + h) / vp.height };
    const bitmap = canvas.transferToImageBitmap();
    postMessage({ type: "bitmap", p: j.p, kind: j.kind, rect, bitmap }, [bitmap]);
  } catch (e) {
    if (!(e instanceof RenderingCancelledException)) {
      console.error(`Rendering page ${j.p + 1} failed`, e);
    }
  } finally {
    if (current === j) {
      current = null;
    }
    schedulePump();
  }
}
