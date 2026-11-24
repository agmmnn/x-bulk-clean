// Reserved for extension lifecycle tasks. X Bulk Clean does not send analytics,
// perform license checks, or open an uninstall survey.

const X_URL = /^https:\/\/(x\.com|twitter\.com)\//;

function configurePanelBehavior() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

configurePanelBehavior();
chrome.runtime.onInstalled.addListener(configurePanelBehavior);
chrome.runtime.onStartup.addListener(configurePanelBehavior);

async function updateSidePanel(tabId, url) {
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: 'sidepanel/sidepanel.html',
      enabled: true
    });
    if (!X_URL.test(url || '')) {
      const stored = await chrome.storage.local.get(['activePreviewSession']);
      if (stored.activePreviewSession?.tabId === tabId) await chrome.storage.local.remove(['activePreviewSession']);
    }
  } catch (_) {}
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'complete') updateSidePanel(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateSidePanel(tabId, tab.url);
  } catch (_) {}
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const stored = await chrome.storage.local.get(['activePreviewSession']);
  if (stored.activePreviewSession?.tabId === tabId) await chrome.storage.local.remove(['activePreviewSession']);
});
