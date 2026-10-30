// Shared test setup: a static server for tests/fixtures and a Chrome for
// Testing instance with the extension loaded.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer";

export const EXT_DIR = resolve(process.env.EXT ?? "extension");
const FIXTURES = resolve("tests/fixtures");
// The stock pdf.js viewer, served for side-by-side comparisons.
const STOCK = resolve("reference/pdfjs-dist");

const TYPES = {
  pdf: "application/pdf",
  html: "text/html",
  mjs: "text/javascript",
  js: "text/javascript",
  css: "text/css",
  svg: "image/svg+xml",
  ftl: "text/plain",
  json: "application/json",
  wasm: "application/wasm",
};

export async function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, "http://x").pathname).slice(1);
      const file = name.startsWith("stock/") ? join(STOCK, name.slice(6)) : join(FIXTURES, name);
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": TYPES[file.split(".").pop()] ?? "application/octet-stream",
        "content-length": body.length,
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}/` };
}

export async function launch({ headless = true } = {}) {
  const browser = await puppeteer.launch({
    // BROWSER=<path to chrome.exe/vivaldi.exe> tests another Chromium build
    // (headful, since such browsers' own UI is part of what's being tested).
    ...(process.env.BROWSER ? { executablePath: process.env.BROWSER, headless: false } : { headless }),
    enableExtensions: [EXT_DIR],
    pipe: true,
    args: ["--window-size=1280,900"],
    defaultViewport: null,
  });
  // Give the service worker a moment to register the DNR rules.
  await browser.waitForTarget(t => t.type() === "service_worker", { timeout: 10000 });
  await new Promise(r => setTimeout(r, 500));
  return browser;
}

// Navigates to a PDF and returns the frame our viewer runs in: an iframe in
// the browser's PDF document, or the top frame when redirected.
export async function openPdf(page, url, { timeout = 20000 } = {}) {
  await page.goto(url).catch(() => {});
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const frame = page.frames().find(f => f.url().includes("/viewer/viewer.html"));
    if (frame) {
      return frame;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`viewer did not open ${url}: ${page.frames().map(f => f.url())}`);
}
