// PDFs served as application/pdf are taken over in place by contentscript.js,
// which keeps the real URL in the address bar. This script only redirects PDFs
// that Chrome would download instead of display (wrong MIME type), and
// local files when file access hasn't been granted yet.
// Adapted from pdf.js extensions/chromium/pdfHandler.js (Apache-2.0).

const VIEWER_URL = chrome.runtime.getURL("viewer/viewer.html");

// Session storage guarantees the rules are (re)registered at least once per
// browser session; onInstalled alone does not fire in every case.
chrome.storage.session.get({ hasPdfRedirector: false }, async items => {
  if (items?.hasPdfRedirector) {
    return;
  }
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  if (rules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: rules.map(r => r.id),
    });
  }
  await registerPdfRedirectRules();
  chrome.storage.session.set({ hasPdfRedirector: true });
});

async function registerPdfRedirectRules() {
  // "allow" ignores this extension's lower-priority rules.
  const IGNORE = { type: "allow" };
  // DNR cannot URL-encode the match, so the raw URL is appended after "?DNR:"
  // and the viewer parses it from there.
  const REDIRECT = {
    type: "redirect",
    redirect: { regexSubstitution: VIEWER_URL + "?DNR:\\1" },
  };
  const FRAMES = ["main_frame", "sub_frame"];

  // Highest priority first.
  const addRules = [
    {
      // Respect Content-Disposition: attachment in iframes.
      condition: {
        urlFilter: "*",
        resourceTypes: ["sub_frame"],
        responseHeaders: [{ header: "content-disposition", values: ["attachment*"] }],
      },
      action: IGNORE,
    },
    {
      // Download links such as Google Drive's "?export=download".
      condition: {
        urlFilter: "=download",
        resourceTypes: ["main_frame"],
        responseHeaders: [{ header: "content-disposition", values: ["attachment*"] }],
      },
      action: IGNORE,
    },
    {
      // Wrong MIME type, but the URL says .pdf.
      condition: {
        regexFilter: "^(.*\\.pdf\\b.*)$",
        excludedRequestMethods: ["post"],
        resourceTypes: FRAMES,
        responseHeaders: [
          {
            header: "content-type",
            values: ["application/octet-stream", "application/octet-stream;*"],
          },
        ],
      },
      action: REDIRECT,
    },
    {
      // Wrong MIME type, but Content-Disposition names a .pdf file.
      condition: {
        regexFilter: "^(.*)$",
        excludedRequestMethods: ["post"],
        resourceTypes: FRAMES,
        responseHeaders: [
          { header: "content-disposition", values: ["*.pdf", '*.pdf"*', "*.pdf'*"] },
        ],
        // responseHeaders is an OR; this double negation restricts the match
        // to octet-stream (or missing) content types.
        excludedResponseHeaders: [
          {
            header: "content-type",
            excludedValues: ["application/octet-stream", "application/octet-stream;*"],
          },
        ],
      },
      action: REDIRECT,
    },
  ];
  for (const [i, rule] of addRules.entries()) {
    rule.id = i + 1;
    rule.priority = addRules.length - i;
  }
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules });
  } catch (e) {
    console.error("Failed to register PDF redirect rules.", e);
  }
}

function getViewerURL(pdfUrl) {
  let hash = "";
  const i = pdfUrl.indexOf("#");
  if (i > 0) {
    hash = pdfUrl.slice(i);
    pdfUrl = pdfUrl.slice(0, i);
  }
  return VIEWER_URL + "?file=" + encodeURIComponent(pdfUrl) + hash;
}

// Without file access, content scripts don't run on file: pages, but
// webNavigation still sees them. Open the viewer, which explains how to grant
// access.
chrome.webNavigation.onBeforeNavigate.addListener(
  details => {
    if (details.frameId !== 0) {
      return;
    }
    chrome.extension.isAllowedFileSchemeAccess(allowed => {
      if (!allowed) {
        chrome.tabs.update(details.tabId, { url: getViewerURL(details.url) });
      }
    });
  },
  {
    url: [
      { urlPrefix: "file://", pathSuffix: ".pdf" },
      { urlPrefix: "file://", pathSuffix: ".PDF" },
    ],
  }
);

// Frames whose current navigation is a POST, as "tabId:frameId". The content
// script asks before taking over, since the viewer would re-fetch with GET.
const postFrames = new Set();
chrome.webRequest.onBeforeRequest.addListener(
  details => {
    const key = `${details.tabId}:${details.frameId}`;
    if (details.method === "POST") {
      postFrames.add(key);
    } else {
      postFrames.delete(key);
    }
  },
  { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] }
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "isPostFrame") {
    sendResponse(postFrames.has(`${sender.tab?.id}:${sender.frameId}`));
  }
});
