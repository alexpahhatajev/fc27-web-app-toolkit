// Shows the toolbar icon as active only on the Web App; everywhere else Chrome draws it greyed out.
// declarativeContent rules are kept by Chrome across restarts; the default "disabled" state is set again on startup.
const WEB_APP = new chrome.declarativeContent.PageStateMatcher({
  pageUrl: { schemes: ["https"], hostEquals: "www.ea.com", pathPrefix: "/ea-sports-fc/ultimate-team/web-app/" },
});

function setUp() {
  chrome.action.disable();
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([{ conditions: [WEB_APP], actions: [new chrome.declarativeContent.ShowAction()] }]);
  });
}

chrome.runtime.onInstalled.addListener(setUp);
chrome.runtime.onStartup.addListener(() => chrome.action.disable());
