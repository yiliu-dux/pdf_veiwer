// Copies pdf.js from the pinned pdfjs-dist npm package into the extension.
// To update pdf.js: bump the version in package.json, npm install, rerun this.
import { cpSync, rmSync } from "node:fs";

const src = "node_modules/pdfjs-dist/";
const dest = "extension/lib/pdfjs/";

rmSync(dest, { recursive: true, force: true });
for (const path of [
  "build/pdf.mjs",
  "build/pdf.worker.mjs",
  "cmaps",
  "standard_fonts",
  "wasm",
  "iccs",
  "LICENSE",
]) {
  cpSync(src + path, dest + path.replace("build/", ""), { recursive: true });
}
console.log(`pdf.js copied to ${dest}`);
