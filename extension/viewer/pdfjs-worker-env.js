// Running pdf.js's display layer inside a worker. pdf.js assumes a DOM in a
// few places; these stand-ins cover everything page rendering needs.

import * as pdfjs from "../lib/pdfjs/pdf.mjs";

export const { RenderingCancelledException } = pdfjs;

const LIB = new URL("../lib/pdfjs/", import.meta.url).href;

pdfjs.GlobalWorkerOptions.workerPort = new Worker(LIB + "pdf.worker.mjs", { type: "module" });

// CPU-backed canvases: rasterizing on this worker's thread keeps heavy pages
// from flooding the GPU process, which also composites (scrolls) the view.
export function createCanvas(width, height) {
  const canvas = new OffscreenCanvas(width, height);
  return { canvas, context: canvas.getContext("2d", { alpha: false, willReadFrequently: true }) };
}

class OffscreenCanvasFactory {
  create(width, height) {
    if (width <= 0 || height <= 0) {
      throw new Error("Invalid canvas size");
    }
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext("2d", { willReadFrequently: true }) };
  }

  reset({ canvas }, width, height) {
    canvas.width = width;
    canvas.height = height;
  }

  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = canvasAndContext.context = null;
  }
}

// pdf.js implements a few rare effects (transfer functions, knockout groups)
// with SVG filters, which need a DOM; without one they are skipped.
class NoopFilterFactory {
  createSelectionStyle() {
    return "";
  }
  destroy() {}
}
for (const name of [
  "addFilter",
  "addHCMFilter",
  "addAlphaFilter",
  "addLuminosityFilter",
  "addKnockoutFilter",
  "addHighlightHCMFilter",
  "addSelectionHCMFilter",
  "addSelectionFilter",
]) {
  NoopFilterFactory.prototype[name] = () => "none";
}

export function openDocument({ url, data }) {
  return pdfjs.getDocument({
    // A URL object, because pdf.js resolves strings against window.location.
    url: url && new URL(url),
    data,
    withCredentials: true,
    cMapUrl: LIB + "cmaps/",
    standardFontDataUrl: LIB + "standard_fonts/",
    wasmUrl: LIB + "wasm/",
    iccUrl: LIB + "iccs/",
    useWorkerFetch: true,
    isOffscreenCanvasSupported: true,
    // Fonts only need a FontFaceSet; workers have their own.
    ownerDocument: { fonts: self.fonts, adoptedStyleSheets: [] },
    CanvasFactory: OffscreenCanvasFactory,
    FilterFactory: NoopFilterFactory,
  }).promise;
}
