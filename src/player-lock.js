// Player locks: a "Lock for SBC" row in the panel of a player you own (club, squad) marks that card as kept, and
// the Auto fill of one-click SBCs (sbc-helper.js, through window.fc27IsLocked) never uses it. Locked cards show a
// lock badge in club lists. Locks are kept per card (item id) through storage-bridge.js. Runs in the page world.
(() => {
  const ROW_CLASS = "fc27-lock-row";
  const BADGE_CLASS = "fc27-lock-badge";
  const locks = {}; // item id -> { name, rating }

  const bridge = (type, data) =>
    new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        window.removeEventListener("message", onReply);
        resolve(null);
      }, 5000);
      const onReply = (event) => {
        if (event.source !== window || !event.data || event.data.source !== "fc27-ext" || event.data.id !== id) return;
        window.removeEventListener("message", onReply);
        clearTimeout(timer);
        resolve(event.data.locks);
      };
      window.addEventListener("message", onReply);
      window.postMessage({ source: "fc27-page", id, type, locks: data }, location.origin);
    });

  bridge("locks:get").then((saved) => {
    Object.assign(locks, saved || {});
    refreshAll();
  });

  window.fc27IsLocked = (itemId) => !!locks[itemId];

  function toggle(item) {
    if (locks[item.id]) delete locks[item.id];
    else locks[item.id] = { name: (item._staticData && item._staticData.name) || "", rating: item.rating };
    bridge("locks:set", { ...locks });
    refreshAll();
  }

  // The hooked panels show cards you own (club lists, squad slots).
  const isOwnedPlayer = (item) => item && typeof item.isPlayer === "function" && item.isPlayer() && item.id > 0;

  // The panel row, first in the panel's own list of actions, drawn like the app's rows.
  function decoratePanel(root, item) {
    const group = root && root.querySelector(".ut-button-group");
    let row = group && group.querySelector(`:scope > .${ROW_CLASS}`);
    if (!group || !isOwnedPlayer(item)) {
      if (row) row.remove();
      return;
    }
    if (!row) {
      row = document.createElement("button");
      row.type = "button";
      row.className = ROW_CLASS;
      row.append(Object.assign(document.createElement("span"), { className: "btn-text" }), Object.assign(document.createElement("span"), { className: "btn-subtext" }));
      row.addEventListener("click", (event) => {
        event.stopPropagation();
        if (row.__fc27Item) toggle(row.__fc27Item);
      });
      group.prepend(row);
    }
    row.__fc27Item = item;
    updateRow(row);
  }

  function updateRow(row) {
    const locked = !!locks[row.__fc27Item.id];
    row.classList.toggle("is-locked", locked);
    row.querySelector(".btn-text").textContent = locked ? "Unlock for SBC" : "Lock for SBC";
    row.querySelector(".btn-subtext").textContent = locked ? "Auto fill will not use this card" : "";
    row.title = locked ? "This card is kept out of Auto fill in SBCs. Click to allow it again." : "Keep this card out of Auto fill in SBCs.";
  }

  function decorateRow(root, item) {
    const content = root && (root.querySelector(".rowContent") || root);
    let badge = content && content.querySelector(`:scope > .${BADGE_CLASS}`);
    const locked = !!(item && locks[item.id]);
    if (!locked) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = BADGE_CLASS;
      badge.title = "Locked for SBC";
      content.append(badge);
    }
  }

  // Rows and panels already on screen follow a change at once.
  const rowItems = new WeakMap();
  function refreshAll() {
    for (const row of document.querySelectorAll(`.${ROW_CLASS}`)) if (row.__fc27Item) updateRow(row);
    for (const li of document.querySelectorAll(".listFUTItem")) if (rowItems.has(li)) decorateRow(li, rowItems.get(li));
  }

  function hook(cls, method, apply) {
    const proto = cls && cls.prototype;
    if (!proto || typeof proto[method] !== "function") return;
    const original = proto[method];
    proto[method] = function (item) {
      const result = original.apply(this, arguments);
      try {
        apply(this, item);
      } catch (e) {
        // Never break the app's own view.
      }
      return result;
    };
  }

  const ready = setInterval(() => {
    if (!window.UTDefaultActionPanelView || !window.UTItemTableCellView) return;
    clearInterval(ready);
    hook(window.UTDefaultActionPanelView, "render", (view, item) => decoratePanel(view.getRootElement(), item));
    hook(window.UTSlotActionPanelView, "setItem", (view, item) => decoratePanel(view.getRootElement(), item));
    hook(window.UTItemTableCellView, "render", (view) => {
      const root = view.getRootElement();
      const item = view.getData();
      rowItems.set(root, item);
      decorateRow(root, item);
    });
  }, 200);
})();
