// Runs in the extension's isolated world and gives the page scripts access to chrome.storage.local.
// Messages: { source: "fc27-page", id, type: "history:get" | "history:merge", personaId, records }
//        -> { source: "fc27-ext", id, history };
//           { source: "fc27-page", id, type: "shortcuts:get" | "shortcuts:set", shortcuts }
//        -> { source: "fc27-ext", id, shortcuts } (key bindings, { [shortcut id]: event.code }).
//           { source: "fc27-page", id, type: "paid:get" | "paid:merge", paid }
//        -> { source: "fc27-ext", id, paid } (price paid per item id, { [item id]: coins }).
(() => {
  const HISTORY_KEY = "matchHistory";
  const SHORTCUTS_KEY = "shortcuts";
  const PAID_KEY = "paidPrices";
  const PAID_LIMIT = 1000;

  async function history(msg) {
    const stored = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] || {};
    const persona = stored[msg.personaId] || { since: Date.now(), rivals: {}, champs: {}, battles: {} };
    if (msg.type === "history:merge") {
      for (const { mode, key, value } of msg.records || []) {
        persona[mode][key] = { ...value, updated: Date.now() };
      }
      stored[msg.personaId] = persona;
      await chrome.storage.local.set({ [HISTORY_KEY]: stored });
    }
    return { history: persona };
  }

  async function shortcuts(msg) {
    if (msg.type === "shortcuts:set") await chrome.storage.local.set({ [SHORTCUTS_KEY]: msg.shortcuts || {} });
    return { shortcuts: (await chrome.storage.local.get(SHORTCUTS_KEY))[SHORTCUTS_KEY] || {} };
  }

  // Prices paid, kept for the newest PAID_LIMIT items (object keys keep insertion order).
  async function paid(msg) {
    let stored = (await chrome.storage.local.get(PAID_KEY))[PAID_KEY] || {};
    if (msg.type === "paid:merge") {
      for (const [id, price] of Object.entries(msg.paid || {})) {
        delete stored[id];
        stored[id] = price;
      }
      stored = Object.fromEntries(Object.entries(stored).slice(-PAID_LIMIT));
      await chrome.storage.local.set({ [PAID_KEY]: stored });
    }
    return { paid: stored };
  }

  const handlers = {
    "history:get": history,
    "history:merge": history,
    "shortcuts:get": shortcuts,
    "shortcuts:set": shortcuts,
    "paid:get": paid,
    "paid:merge": paid,
  };

  window.addEventListener("message", async (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.source !== "fc27-page" || !handlers[msg.type]) return;
    const reply = await handlers[msg.type](msg);
    window.postMessage({ source: "fc27-ext", id: msg.id, ...reply }, location.origin);
  });
})();
