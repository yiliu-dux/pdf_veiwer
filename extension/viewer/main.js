// Viewer entry point: works out which PDF to show, opens it in the render
// worker, and connects the worker to the view.
//
// Viewer URLs are "?file=<encoded url>", or "?DNR:<raw url>" when redirected
// by background.js (declarativeNetRequest can't encode its substitution).

import { PdfView } from "./view.js";

const statusEl = document.getElementById("status");
const indicator = document.getElementById("indicator");

const pdfUrl = readPdfUrl();
const worker = new Worker("render-worker.js", { type: "module" });
const view = new PdfView({
  sizer: document.getElementById("sizer"),
  worker,
  onChange: () => {
    indicator.textContent =
      `${view.currentPage + 1} / ${view.pagesCount}  ·  ${Math.round(view.scale * 100)}%`;
  },
});

worker.onmessage = ({ data: msg }) => {
  switch (msg.type) {
    case "bitmap":
      view.showBitmap(msg);
      break;
    case "doc":
      if (msg.title) {
        setTitle(msg.title);
      }
      statusEl.hidden = true;
      indicator.hidden = false;
      view.setDocument(msg.sizes);
      break;
    case "error":
      showStatus(`Failed to load PDF: ${msg.message}`);
      break;
  }
};

// Test hook: lets automated tests read the view state.
globalThis.viewerState = () => ({ scale: view.scale, scrollTop: document.scrollingElement.scrollTop });

open();

async function open() {
  if (!pdfUrl) {
    showStatus("No PDF specified.");
    return;
  }
  // The viewer is web-accessible, so any site could frame it; never let a web
  // page display the user's local files.
  const isFile = pdfUrl.startsWith("file:");
  if (isFile && [...location.ancestorOrigins].some(o => o !== "file://")) {
    showStatus("Local files can't be shown inside a web page.");
    return;
  }
  setTitle(decodeURIComponent(pdfUrl.split(/[?#]/)[0].split("/").pop() || pdfUrl));
  showStatus("Loading…");

  if (!isFile) {
    worker.postMessage({ type: "open", url: pdfUrl });
    return;
  }
  if (!(await chrome.extension.isAllowedFileSchemeAccess())) {
    showFileAccessHelp();
    return;
  }
  try {
    const data = await readLocalFile(pdfUrl);
    worker.postMessage({ type: "open", data }, [data.buffer]);
  } catch (e) {
    showStatus(e.message);
  }
}

function readPdfUrl() {
  const q = location.search;
  if (q.startsWith("?DNR:")) {
    const url = q.slice(5);
    history.replaceState(null, "", `?file=${encodeURIComponent(url)}${location.hash}`);
    return url;
  }
  return new URLSearchParams(q).get("file") ?? "";
}

// When shown in place of the browser's viewer (contentscript.js), the hosting
// page is the PDF's own document; pass the title up so the tab shows it. The
// target origin limits delivery to that document; local files are only shown
// under file: ancestors (checked in open), so "*" is safe there.
function setTitle(title) {
  document.title = title;
  if (window !== top) {
    const origin = pdfUrl.startsWith("file:") ? "*" : new URL(pdfUrl).origin;
    parent.postMessage({ pdfTitle: title }, origin);
  }
}

function showStatus(text) {
  statusEl.textContent = text;
  statusEl.hidden = false;
}

function showFileAccessHelp() {
  showStatus('To open local PDFs, enable "Allow access to file URLs" for this extension, then reload.');
  const button = document.createElement("button");
  button.textContent = "Open extension settings";
  button.onclick = () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  statusEl.append(document.createElement("br"), button);
}

// fetch() doesn't support file: URLs; XHR does for extensions with file access.
function readLocalFile(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.responseType = "arraybuffer";
    xhr.onload = () => resolve(new Uint8Array(xhr.response));
    xhr.onerror = () => reject(new Error(`Cannot read ${url}`));
    xhr.send();
  });
}
