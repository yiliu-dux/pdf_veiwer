// Opens a PDF over http, checks the extension takes over and renders, then
// zooms far in (tiled rendering path) and screenshots both states.
import { launch, openPdf, startServer } from "./harness.mjs";

const fixture = process.argv[2] ?? "tracemonkey.pdf";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { server, base } = await startServer();
const browser = await launch();
const page = await browser.newPage();
const logs = [];
page.on("console", m => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", e => logs.push(`[pageerror] ${e.message}`));
try {
  const viewer = await openPdf(page, base + fixture);
  if (page.url() !== base + fixture) {
    throw new Error(`address bar shows ${page.url()}`);
  }
  await viewer.waitForSelector(".page[data-high]", { timeout: 20000 });
  console.log("tab title:", await page.title());
  console.log("rendered:", await viewer.evaluate(() => ({
    indicator: document.getElementById("indicator").textContent,
  })));
  await page.screenshot({ path: "tests/out-smoke.png" });

  await page.mouse.click(640, 400);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.down("Control");
    await page.keyboard.press("Equal");
    await page.keyboard.up("Control");
  }
  await sleep(3000);
  console.log("zoomed:", await viewer.evaluate(() => ({
    indicator: document.getElementById("indicator").textContent,
    tiles: [...document.querySelectorAll(".page[data-high] canvas.high")].map(c => c.style.cssText),
  })));
  await page.screenshot({ path: "tests/out-smoke-zoomed.png" });
  console.log("OK");
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  if (logs.length) {
    console.log(logs.join("\n"));
  }
  await browser.close();
  server.close();
}
