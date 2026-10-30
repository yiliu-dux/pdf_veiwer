// Chrome shows a PDF as a document at the PDF's own URL that hosts its
// built-in viewer. We cover that document with our viewer in a full-size
// iframe, so the address bar keeps the real URL (and reload/back work).
// Approach adapted from pdf.js extensions/chromium/contentscript.js.

if (document.contentType === "application/pdf") {
  // Hide the built-in viewer's <embed> before it is ever laid out: a closed
  // shadow root on <body> stops its (unslotted) children from rendering, so
  // the built-in viewer never starts. Removing the <embed> later is too late;
  // some builds (e.g. Vivaldi) keep the viewer running.
  whenBody(() => {
    const shadow = document.body.attachShadow({ mode: "closed" });
    // A POST response can't be re-fetched by our viewer; for those, show the
    // built-in viewer after all by slotting the original content back in.
    chrome.runtime.sendMessage({ action: "isPostFrame" }, isPost => {
      shadow.append(isPost ? document.createElement("slot") : createViewerFrame());
    });
  });
}

function whenBody(callback) {
  if (document.body) {
    callback();
    return;
  }
  // Mutation callbacks run before the next layout, so the <embed> is never
  // rendered.
  const observer = new MutationObserver(() => {
    if (document.body) {
      observer.disconnect();
      callback();
    }
  });
  observer.observe(document, { childList: true, subtree: true });
}

function createViewerFrame() {
  const viewerUrl = new URL(chrome.runtime.getURL("viewer/viewer.html"));
  const hashIndex = document.URL.indexOf("#");
  const pdfUrl = hashIndex < 0 ? document.URL : document.URL.slice(0, hashIndex);
  viewerUrl.search = `?file=${encodeURIComponent(pdfUrl)}`;
  viewerUrl.hash = hashIndex < 0 ? "" : document.URL.slice(hashIndex);

  const iframe = document.createElement("iframe");
  iframe.src = viewerUrl.href;
  iframe.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;border:0;margin:0;padding:0;";
  iframe.addEventListener("load", () => iframe.focus(), { once: true });

  // The viewer reports the document title so the tab shows it.
  addEventListener("message", e => {
    if (e.source === iframe.contentWindow && typeof e.data?.pdfTitle === "string") {
      document.title = e.data.pdfTitle;
    }
  });
  return iframe;
}
