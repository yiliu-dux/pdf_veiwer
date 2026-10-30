// Checks that the browser considers a PDF tab finished loading (no stuck
// progress bar), per chrome.tabs in the extension's service worker.
// Usage: [BROWSER=<exe>] node tests/tab-status.mjs [url]
import { launch, startServer } from "./harness.mjs";

const { server, base } = await startServer();
const browser = await launch();
const sw = await (await browser.waitForTarget(t => t.url().endsWith("/background.js"))).worker();
const page = await browser.newPage();
await page.goto(process.argv[2] ?? base + "tracemonkey.pdf").catch(() => {});
let status;
for (let i = 0; i < 16; i++) {
  await new Promise(r => setTimeout(r, 500));
  status = await sw.evaluate(() =>
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t?.status)
  );
  if (status === "complete") {
    break;
  }
}
console.log(`tab status: ${status}`);
console.log("frames:", page.frames().map(f => f.url().slice(0, 70)));
process.exitCode = status === "complete" ? 0 : 1;
await browser.close();
server.close();
