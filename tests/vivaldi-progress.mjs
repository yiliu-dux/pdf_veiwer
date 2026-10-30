// Vivaldi's address-field progress bar must finish after a PDF opens (it got
// stuck when PDFs were taken over by redirecting to the extension page).
// Reads the indicator from Vivaldi's own UI document. Skipped if Vivaldi
// isn't installed. Usage: node tests/vivaldi-progress.mjs [url]
//
// Manual check, not part of npm test: Vivaldi's UI stops updating while its
// window is covered by other windows, so keep the test window visible.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { launch, openPdf, startServer } from "./harness.mjs";

const VIVALDI = join(process.env.LOCALAPPDATA ?? "", "Vivaldi/Application/vivaldi.exe");
if (!existsSync(VIVALDI)) {
  console.log("SKIPPED: Vivaldi not installed");
  process.exit(0);
}
process.env.BROWSER = VIVALDI;

const { server, base } = await startServer();
const browser = await launch();
const page = await browser.newPage();
// Under automation Vivaldi can leave new tabs in the background at 0x0.
await page.setViewport({ width: 1200, height: 800 });
const pdfUrl = process.argv[2] ?? base + "tracemonkey.pdf";
const viewer = await openPdf(page, pdfUrl);
await viewer.waitForSelector(".page[data-high]", { timeout: 20000 }).catch(async e => {
  const state = await viewer.evaluate(() => ({
    size: [innerWidth, innerHeight],
    status: document.getElementById("status").textContent,
    pages: document.querySelectorAll(".page").length,
    ...globalThis.viewerState(),
  }));
  console.log("FAILED: viewer didn't render", state);
  process.exit(1);
});
// Vivaldi's UI only shows the active tab's progress; activate ours.
const sw = await (await browser.waitForTarget(t => t.url().endsWith("/background.js"))).worker();
await sw.evaluate(async url => {
  const tab = (await chrome.tabs.query({})).find(t => t.url === url);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
}, page.url());

const probe = () => {
  const field = document.querySelector(".UrlBar-AddressField");
  const load = field?.querySelector(".pageload");
  return {
    url: field?.querySelector("input")?.value,
    done: !load || load.classList.contains("progress-done"),
    state: load?.className ?? "(no indicator)",
  };
};
// Each browser window has its own UI document showing its active tab; the
// new tab may have opened in its own window, so check them all.
const windows = await Promise.all(
  browser.targets().filter(t => t.url().endsWith("/window.html")).map(t => t.createCDPSession())
);
let result;
for (let i = 0; i < 20 && !result?.ok; i++) {
  await new Promise(r => setTimeout(r, 250));
  for (const ui of windows) {
    const r = await ui.send("Runtime.evaluate", { returnByValue: true, expression: `(${probe})()` });
    if (r.result.value?.url === page.url() || !result) {
      result = r.result.value;
      result.ok = result.done && result.url === page.url();
    }
  }
}
console.log(result.ok ? "OK:" : "FAILED:", result);
process.exitCode = result.ok ? 0 : 1;
await browser.close();
server.close();
