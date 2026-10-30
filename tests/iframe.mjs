// A PDF in an <iframe> should open in our viewer inside the frame.
import { launch, startServer } from "./harness.mjs";

const { server, base } = await startServer();
const browser = await launch();
const page = await browser.newPage();
await page.goto(base + "iframe.html");
await new Promise(r => setTimeout(r, 3000));
const frame = page.frames().find(f => f.url().startsWith("chrome-extension://"));
if (frame && (await frame.$(".page[data-high]"))) {
  console.log("OK:", frame.url());
} else {
  console.log("FAILED:", page.frames().map(f => f.url()));
  process.exitCode = 1;
}
await browser.close();
server.close();
