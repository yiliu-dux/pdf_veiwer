// Opens a file:// PDF and checks that the extension takes over and renders.
// (Extensions loaded by the test harness get file access automatically, so
// the "grant file access" screen isn't exercised here.)
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { launch, openPdf } from "./harness.mjs";

const browser = await launch();
const page = await browser.newPage();
page.on("pageerror", e => console.log(`[pageerror] ${e.message}`));
const url = pathToFileURL(resolve("tests/fixtures/tracemonkey.pdf")).href;
const t0 = Date.now();
try {
  const viewer = await openPdf(page, url);
  await viewer.waitForSelector(".page[data-high]", { timeout: 15000 });
  console.log(`OK: rendered in ${Date.now() - t0} ms`, page.url());
} catch {
  console.log("FAILED:", page.frames().map(f => f.url()));
  process.exitCode = 1;
}
await browser.close();
