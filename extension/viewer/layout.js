// Page geometry for a vertical, continuous layout, in CSS px. Pages are
// stacked top to bottom and centered horizontally; padding and gaps don't
// scale with zoom.

export const PAD = 16; // around the document
export const GAP = 10; // between pages

export class PageLayout {
  scale = 1;
  viewportWidth = 0;

  // sizes: [w0, h0, w1, h1, ...] at scale 1.
  constructor(sizes) {
    const n = (this.count = sizes.length / 2);
    this.w = new Float64Array(n);
    this.h = new Float64Array(n);
    this.cumH = new Float64Array(n + 1); // cumH[i] = h[0] + … + h[i-1]
    this.maxW = 0;
    for (let i = 0; i < n; i++) {
      this.w[i] = sizes[2 * i];
      this.h[i] = sizes[2 * i + 1];
      this.cumH[i + 1] = this.cumH[i] + this.h[i];
      this.maxW = Math.max(this.maxW, this.w[i]);
    }
  }

  pageWidth(i) {
    return this.w[i] * this.scale;
  }

  pageHeight(i) {
    return this.h[i] * this.scale;
  }

  top(i) {
    return PAD + this.cumH[i] * this.scale + i * GAP;
  }

  left(i) {
    return (this.docWidth() - this.pageWidth(i)) / 2;
  }

  docWidth() {
    return Math.max(this.viewportWidth, this.maxW * this.scale + 2 * PAD);
  }

  docHeight() {
    return 2 * PAD + this.cumH[this.count] * this.scale + (this.count - 1) * GAP;
  }

  fitWidthScale() {
    return (this.viewportWidth - 2 * PAD) / this.maxW;
  }

  // Last page whose top is at or above y.
  pageAt(y) {
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.top(mid) <= y) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }
}
