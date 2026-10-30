// Generates tests/fixtures/heavy.pdf: many pages of dense vector art, which
// is the worst case for canvas rendering cost.
import { writeFileSync } from "node:fs";
import { PDFDocument, PDFName } from "pdf-lib";

const PAGES = Number(process.argv[2] ?? 300);
const SEGMENTS = Number(process.argv[3] ?? 40000);
// "single": one giant path per page, drawn by a single canvas operation that
// pdf.js cannot split into chunks. "many": many small stroked paths.
const MODE = process.argv[4] ?? "single";
const OUT = process.argv[5] ?? "tests/fixtures/heavy.pdf";

let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const doc = await PDFDocument.create();
const streams = [];
for (let s = 0; s < 4; s++) {
  let ops = "0.3 w\n";
  for (let i = 0; i < SEGMENTS; i++) {
    if (MODE !== "single" && i % 500 === 0) {
      ops += `${rand().toFixed(2)} ${rand().toFixed(2)} ${rand().toFixed(2)} RG\n`;
    }
    const x = 36 + rand() * 540;
    const y = 36 + rand() * 720;
    ops += `${x.toFixed(1)} ${y.toFixed(1)} m ${(x + rand() * 40 - 20).toFixed(1)} ${(y + rand() * 40 - 20).toFixed(1)} l S\n`;
  }
  streams.push(doc.context.register(doc.context.flateStream(ops)));
}
for (let p = 0; p < PAGES; p++) {
  // Mix in a few landscape pages so page sizes vary.
  const page = doc.addPage(p % 25 === 24 ? [792, 612] : [612, 792]);
  page.node.set(PDFName.of("Contents"), streams[p % streams.length]);
}
writeFileSync(OUT, await doc.save());
console.log(`${OUT}: ${PAGES} pages x ${SEGMENTS} segments (${MODE})`);
