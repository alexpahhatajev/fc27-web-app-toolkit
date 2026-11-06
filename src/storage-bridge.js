// Runs in the extension's isolated world and gives the page scripts access to chrome.storage.local.
// Messages: { source: "fc27-page", id, type: "history:get" | "history:merge", personaId, records }
//        -> { source: "fc27-ext", id, history };
//           { source: "fc27-page", id, type: "shortcuts:get" | "shortcuts:set", shortcuts }
//        -> { source: "fc27-ext", id, shortcuts } (key bindings, { [shortcut id]: event.code }).
//           { source: "fc27-page", id, type: "paid:get" | "paid:merge", paid }
//        -> { source: "fc27-ext", id, paid } (price paid per item id, { [item id]: coins }).
//           { source: "fc27-page", id, type: "offmarket:get" | "offmarket:merge", offMarket }
//        -> { source: "fc27-ext", id, offMarket } (players without any listing, { [player id]: time seen }).
//           { source: "fc27-page", id, type: "locks:get" | "locks:set", locks }
//        -> { source: "fc27-ext", id, locks } (cards kept out of SBC Auto fill, { [item id]: { name, rating } }).
(() => {
  const HISTORY_KEY = "matchHistory";
  const SHORTCUTS_KEY = "shortcuts";
  const PAID_KEY = "paidPrices";
  const PAID_LIMIT = 1000;
  const OFF_MARKET_KEY = "offMarket";
  const OFF_MARKET_DAYS = 7;
  const LOCKS_KEY = "lockedPlayers";

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

  // Players seen without any listing; entries older than OFF_MARKET_DAYS are dropped.
  async function offMarket(msg) {
    const stored = (await chrome.storage.local.get(OFF_MARKET_KEY))[OFF_MARKET_KEY] || {};
    const since = Date.now() - OFF_MARKET_DAYS * 24 * 60 * 60 * 1000;
    const kept = Object.fromEntries(Object.entries({ ...stored, ...(msg.offMarket || {}) }).filter(([, seen]) => seen > since));
    if (msg.type === "offmarket:merge" || Object.keys(kept).length !== Object.keys(stored).length) {
      await chrome.storage.local.set({ [OFF_MARKET_KEY]: kept });
    }
    return { offMarket: kept };
  }

  async function locks(msg) {
    if (msg.type === "locks:set") await chrome.storage.local.set({ [LOCKS_KEY]: msg.locks || {} });
    return { locks: (await chrome.storage.local.get(LOCKS_KEY))[LOCKS_KEY] || {} };
  }

  const handlers = {
    "history:get": history,
    "history:merge": history,
    "shortcuts:get": shortcuts,
    "shortcuts:set": shortcuts,
    "paid:get": paid,
    "paid:merge": paid,
    "offmarket:get": offMarket,
    "offmarket:merge": offMarket,
    "locks:get": locks,
    "locks:set": locks,
  };

  window.addEventListener("message", async (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.source !== "fc27-page" || !handlers[msg.type]) return;
    const reply = await handlers[msg.type](msg);
    window.postMessage({ source: "fc27-ext", id: msg.id, ...reply }, location.origin);
  });
})();
