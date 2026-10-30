// The view owns the scroll position and scale, and nothing else. Scrolling is
// the browser's native root scroller, so it runs on the compositor; zoom is
// applied synchronously in the input handler. Only pages near the viewport
// get DOM nodes, so every operation costs the same for any page count.
// Rendering happens in render-worker.js: the view reports what is on screen
// and places the bitmaps it gets back, so input never waits on rendering.

import { PageLayout } from "./layout.js";

const MIN_SCALE = 0.1;
const MAX_SCALE = 32;
// Pages within this many viewport heights of the screen are mounted (and
// rendered ahead); pages beyond UNMOUNT_MARGIN are dropped.
const MOUNT_MARGIN = 1;
const UNMOUNT_MARGIN = 2.5;

const root = document.documentElement;
const scroller = document.scrollingElement;

const clamp01 = v => Math.min(1, Math.max(0, v));
const clampScale = v => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));

export class PdfView {
  #layout = null;
  #sizer;
  #worker;
  #onChange;
  #slots = new Map(); // page index -> { div, low, high } (bitmaprenderer contexts)
  #dpr = devicePixelRatio;
  #ctrlDown = false;
  // The initial fit-to-width waits until the viewport has a size (a tab can
  // start out 0x0).
  #fitPending = false;
  // Scroll position last set by zoomTo. Browsers may snap scroll offsets;
  // zooming from the unsnapped value keeps a long pinch from drifting.
  #zoomScroll = null;

  constructor({ sizer, worker, onChange }) {
    this.#sizer = sizer;
    this.#worker = worker;
    this.#onChange = onChange;

    addEventListener("scroll", () => this.#update(), { passive: true });
    // Non-passive only so Ctrl+wheel can be turned into our zoom.
    addEventListener("wheel", e => this.#onWheel(e), { passive: false });
    addEventListener("keydown", e => this.#onKeyDown(e));
    addEventListener("keyup", e => {
      if (e.key === "Control") {
        this.#ctrlDown = false;
      }
    });
    addEventListener("blur", () => (this.#ctrlDown = false));
    addEventListener("resize", () => this.#onResize());
    this.#watchDpr();
  }

  get scale() {
    return this.#layout?.scale ?? 1;
  }

  get pagesCount() {
    return this.#layout?.count ?? 0;
  }

  // Index of the page at the middle of the viewport.
  get currentPage() {
    return this.#layout?.pageAt(scroller.scrollTop + root.clientHeight / 2) ?? 0;
  }

  setDocument(sizes) {
    this.#layout = new PageLayout(sizes);
    this.#fitPending = true;
    this.#onResize();
  }

  // Zooms keeping the document point under (ax, ay) (client coords) fixed.
  zoomTo(scale, ax = root.clientWidth / 2, ay = root.clientHeight / 2) {
    const layout = this.#layout;
    scale = clampScale(scale);
    if (!layout || scale === layout.scale) {
      return;
    }
    let x = scroller.scrollLeft;
    let y = scroller.scrollTop;
    const z = this.#zoomScroll;
    if (z && Math.abs(x - z.x) < 1 && Math.abs(y - z.y) < 1) {
      ({ x, y } = z);
    }
    // Anchor in unscaled units, relative to the page under it.
    const i = layout.pageAt(y + ay);
    const fx = (x + ax - layout.left(i)) / layout.scale;
    const fy = (y + ay - layout.top(i)) / layout.scale;

    layout.scale = scale;
    this.#relayout();
    this.#zoomScroll = {
      x: layout.left(i) + fx * scale - ax,
      y: layout.top(i) + fy * scale - ay,
    };
    scroller.scrollTo({ left: this.#zoomScroll.x, top: this.#zoomScroll.y, behavior: "instant" });
    this.#update();
  }

  fitWidth() {
    this.zoomTo(this.#layout?.fitWidthScale());
  }

  // A rendered bitmap from the worker. `rect` is the page area it covers, in
  // fractions of the page, so it stays correctly placed (stretched) while the
  // scale changes until a sharper one arrives.
  showBitmap({ p, kind, rect, bitmap }) {
    const slot = this.#slots.get(p);
    if (!slot) {
      bitmap.close();
      return;
    }
    if (kind === "high") {
      Object.assign(slot.high.canvas.style, {
        left: `${rect.x0 * 100}%`,
        top: `${rect.y0 * 100}%`,
        width: `${(rect.x1 - rect.x0) * 100}%`,
        height: `${(rect.y1 - rect.y0) * 100}%`,
      });
    }
    slot[kind].transferFromImageBitmap(bitmap);
    slot.div.dataset[kind] = ""; // lets tests see what has rendered
  }

  #onResize() {
    const layout = this.#layout;
    if (!layout) {
      return;
    }
    layout.viewportWidth = root.clientWidth;
    if (this.#fitPending && layout.viewportWidth > 0) {
      layout.scale = clampScale(layout.fitWidthScale());
      this.#fitPending = false;
    }
    this.#relayout();
    this.#update();
  }

  #relayout() {
    const layout = this.#layout;
    this.#sizer.style.width = `${layout.docWidth()}px`;
    this.#sizer.style.height = `${layout.docHeight()}px`;
    for (const [i, slot] of this.#slots) {
      this.#position(i, slot.div);
    }
  }

  #position(i, div) {
    const layout = this.#layout;
    Object.assign(div.style, {
      left: `${layout.left(i)}px`,
      top: `${layout.top(i)}px`,
      width: `${layout.pageWidth(i)}px`,
      height: `${layout.pageHeight(i)}px`,
    });
  }

  #mount(i) {
    const div = document.createElement("div");
    div.className = "page";
    div.dataset.page = i;
    const low = document.createElement("canvas");
    low.className = "low";
    const high = document.createElement("canvas");
    high.className = "high";
    div.append(low, high);
    this.#position(i, div);
    this.#sizer.append(div);
    this.#slots.set(i, {
      div,
      low: low.getContext("bitmaprenderer"),
      high: high.getContext("bitmaprenderer"),
    });
  }

  #unmount(i) {
    const slot = this.#slots.get(i);
    slot.low.transferFromImageBitmap(null);
    slot.high.transferFromImageBitmap(null);
    slot.div.remove();
    this.#slots.delete(i);
  }

  // Mounts/unmounts pages around the viewport and tells the worker what is on
  // screen. Work is proportional to the number of mounted pages.
  #update() {
    const layout = this.#layout;
    if (!layout) {
      return;
    }
    const vw = root.clientWidth;
    const vh = root.clientHeight;
    const top = scroller.scrollTop;
    const left = scroller.scrollLeft;

    const evicted = [];
    for (const i of this.#slots.keys()) {
      const t = layout.top(i);
      if (t + layout.pageHeight(i) < top - vh * UNMOUNT_MARGIN || t > top + vh * (1 + UNMOUNT_MARGIN)) {
        this.#unmount(i);
        evicted.push(i);
      }
    }
    if (evicted.length) {
      this.#worker.postMessage({ type: "evict", pages: evicted });
    }

    // Pages by distance from the viewport center; `vis` is the visible part
    // in fractions of the page, or null when off-screen.
    const mountTop = top - vh * MOUNT_MARGIN;
    const mountBottom = top + vh * (1 + MOUNT_MARGIN);
    const center = top + vh / 2;
    const visible = [];
    const near = [];
    for (let i = layout.pageAt(mountTop); i < layout.count && layout.top(i) <= mountBottom; i++) {
      const t = layout.top(i);
      const l = layout.left(i);
      const w = layout.pageWidth(i);
      const h = layout.pageHeight(i);
      if (t + h < mountTop) {
        continue;
      }
      if (!this.#slots.has(i)) {
        this.#mount(i);
      }
      const dist = Math.abs(t + h / 2 - center);
      if (t + h > top && t < top + vh && l + w > left && l < left + vw) {
        const vis = {
          x0: clamp01((left - l) / w),
          y0: clamp01((top - t) / h),
          x1: clamp01((left + vw - l) / w),
          y1: clamp01((top + vh - t) / h),
        };
        visible.push({ p: i, dist, vis });
      } else {
        near.push({ p: i, dist, vis: null });
      }
    }
    const byDist = (a, b) => a.dist - b.dist;
    this.#worker.postMessage({
      type: "view",
      scale: layout.scale,
      dpr: this.#dpr,
      visible: visible.sort(byDist),
      near: near.sort(byDist),
    });
    this.#onChange();
  }

  #onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) {
      return; // Plain scrolling stays native.
    }
    e.preventDefault(); // Also stops the browser's page zoom.
    let d = e.deltaY;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      d *= 33;
    } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      d *= root.clientHeight;
    }
    // Touchpad pinches arrive as ctrl+wheel with Ctrl not physically held,
    // encoded as deltaY = -100·ln(scale change). Real Ctrl+wheel (100 per
    // notch) gets a gentler ~1.22x per notch.
    const k = this.#ctrlDown ? 0.002 : 0.01;
    this.zoomTo(this.scale * Math.exp(-d * k), e.clientX, e.clientY);
  }

  #onKeyDown(e) {
    if (e.key === "Control") {
      this.#ctrlDown = true;
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) {
      return;
    }
    if (e.key === "=" || e.key === "+") {
      this.zoomTo(this.scale * 1.25);
    } else if (e.key === "-") {
      this.zoomTo(this.scale / 1.25);
    } else if (e.key === "0") {
      this.fitWidth();
    } else {
      return;
    }
    e.preventDefault();
  }

  #watchDpr() {
    matchMedia(`(resolution: ${this.#dpr}dppx)`).addEventListener(
      "change",
      () => {
        this.#dpr = devicePixelRatio;
        this.#watchDpr();
        this.#update();
      },
      { once: true }
    );
  }
}
