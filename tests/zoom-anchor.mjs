// Pinch-zooms around a fixed cursor position and checks that the document
// point under the cursor doesn't move (within 1 px).
import { launch, openPdf, startServer } from "./harness.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const { server, base } = await startServer();
const browser = await launch();
const page = await browser.newPage();
const viewer = await openPdf(page, base + "heavy.pdf");
await viewer.waitForSelector(".page[data-high]");
// The viewer iframe fills the page, so page and viewer coordinates match.
const cdp = await page.createCDPSession();
const X = 300;
const Y = 500;

// Position of the cursor in the page under it, in unscaled page units.
const probe = () =>
  viewer.evaluate(
    (x, y) => {
      const el = document.elementFromPoint(x, y).closest(".page");
      const r = el.getBoundingClientRect();
      const { scale } = globalThis.viewerState();
      return { page: el.dataset.page, ux: (x - r.left) / scale, uy: (y - r.top) / scale, scale };
    },
    X,
    Y
  );

await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: X, y: Y, deltaX: 0, deltaY: 3000 });
await sleep(500);
const before = await probe();
let worst = 0;
for (const deltaY of [...Array(80).fill(-3), ...Array(80).fill(3)]) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel", x: X, y: Y, deltaX: 0, deltaY, modifiers: 2,
  });
  const now = await probe();
  if (now.page === before.page) {
    worst = Math.max(worst, Math.hypot(now.ux - before.ux, now.uy - before.uy) * now.scale);
  } else {
    worst = Infinity;
  }
}
const after = await probe();
console.log(`scale ${before.scale.toFixed(3)} -> ${after.scale.toFixed(3)}; worst drift ${worst.toFixed(3)} px`);
process.exitCode = worst <= 1 ? 0 : 1;
await browser.close();
server.close();
