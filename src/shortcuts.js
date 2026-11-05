// Keyboard shortcuts for the player panel and the Transfer Market, and a "Shortcuts" entry in the left menu that opens a window
// where the keys can be changed. Runs in the page world; the chosen keys are saved through storage-bridge.js.
// Keys are matched by physical key (event.code), so they work with any keyboard layout, and are ignored while
// typing in a field, with Ctrl/Cmd/Alt held, or while the Shortcuts window is open.
(() => {
  const TAB_CLASS = "fc27-shortcuts-tab";
  const WINDOW_ID = "fc27-shortcuts";
  // The app labels its "Send to My Club" button with one of these texts, depending on where the item is.
  const SEND_TO_CLUB_KEYS = ["infopanel.label.club", "infopanel.label.sendbacktoclub", "infopanel.label.storeInClub"];
  // Letters and digits only: other keys either type into the app or have browser meanings.
  const ALLOWED_CODE = /^(Key[A-Z]|Digit[0-9])$/;

  // Displayed in the panel on screen; it may be scrolled out of view inside the panel. Panels of other screens
  // are hidden or moved off to the side, so only the horizontal position is checked.
  const visible = (el) => {
    if (!el || !el.offsetParent) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth;
  };
  const panelButtons = () => [...document.querySelectorAll(".DetailPanel button")].filter(visible);
  const label = (button) => button.innerText.trim().split("\n")[0].trim();
  const keyName = (code) => code.replace(/^Key|^Digit/, "");

  // The app's buttons react to a mouse press and release, not to a plain click().
  function press(button) {
    const r = button.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    button.dispatchEvent(new MouseEvent("mousedown", init));
    button.dispatchEvent(new MouseEvent("mouseup", init));
  }

  // Search the Transfer Market: price spinners by section (0 Bid Price, 1 Buy Now Price) and field (0 Min, 1 Max).
  function spinnerButton(section, field, kind) {
    const view = [...document.querySelectorAll(".ut-market-search-filters-view")].find(visible);
    if (!view) return null;
    const sections = [...view.querySelectorAll(".ut-market-search-filters-view--criteria-container")].filter((c) =>
      c.querySelector(".price-filter")
    );
    const filter = sections[section] && sections[section].querySelectorAll(".price-filter")[field];
    return filter && filter.querySelector(`.${kind}-value`);
  }

  function stepPrice(section, field, kind) {
    const button = spinnerButton(section, field, kind);
    if (button && !button.disabled) press(button);
  }

  // Presses Ok in the app's "Get Now" confirmation as soon as it is shown, for up to 3 seconds after Buy Now.
  // Only a dialog with that title is confirmed, so any other popup (e.g. not enough coins) is left alone.
  function confirmBuyNow() {
    const title = services.Localization.localize("popup.buyNowConfirmationTitle");
    const tryConfirm = () => {
      const dialog = [...document.querySelectorAll(".ea-dialog-view")].find(
        (d) => d.offsetParent && d.querySelector(".ea-dialog-view--title")?.textContent.trim() === title
      );
      const ok = dialog && dialog.querySelector(".ut-st-button-group .btn-standard.primary");
      if (!ok) return false;
      press(ok);
      return true;
    };
    if (tryConfirm()) return;
    const observer = new MutationObserver(() => tryConfirm() && stop());
    const timer = setTimeout(() => stop(), 3000);
    const stop = () => {
      observer.disconnect();
      clearTimeout(timer);
    };
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Selects the first or last row of the visible search results, presses Buy Now in its panel and confirms
  // the purchase (confirmBuyNow).
  function buyAt(which) {
    const rows = [...document.querySelectorAll(".paginated-item-list .listFUTItem")].filter(visible);
    if (!rows.length) return;
    const row = which === "first" ? rows[0] : rows[rows.length - 1];
    press(row.querySelector(".rowContent") || row);
    if (!row.classList.contains("selected")) return;
    const button = panelButtons().find((b) => b.classList.contains("buyButton"));
    if (!button || button.disabled) return;
    press(button);
    confirmBuyNow();
  }

  const SHORTCUTS = [
    {
      id: "lowestBin",
      defaultCode: "KeyV",
      name: "Lowest BIN",
      where: "Player panel of a tradeable card",
      run() {
        const button = panelButtons().find((b) => b.closest(".fc27-price"));
        if (button && !button.disabled) button.click();
      },
    },
    {
      id: "sendToClub",
      defaultCode: "KeyC",
      name: "Send to My Club",
      where: "Player panel that shows this button",
      run() {
        const texts = SEND_TO_CLUB_KEYS.map((key) => services.Localization.localize(key));
        const button = panelButtons().find((b) => texts.includes(label(b)));
        if (button) press(button);
      },
    },
    {
      id: "bidMinMinus",
      defaultCode: "KeyZ",
      name: "Bid Price Min -",
      where: "Search the Transfer Market",
      run: () => stepPrice(0, 0, "decrement"),
    },
    {
      id: "bidMinPlus",
      defaultCode: "KeyX",
      name: "Bid Price Min +",
      where: "Search the Transfer Market",
      run: () => stepPrice(0, 0, "increment"),
    },
    {
      id: "buyNowMaxMinus",
      defaultCode: "KeyQ",
      name: "Buy Now Price Max -",
      where: "Search the Transfer Market",
      run: () => stepPrice(1, 1, "decrement"),
    },
    {
      id: "buyNowMaxPlus",
      defaultCode: "KeyW",
      name: "Buy Now Price Max +",
      where: "Search the Transfer Market",
      run: () => stepPrice(1, 1, "increment"),
    },
    {
      id: "search",
      defaultCode: "KeyS",
      name: "Search",
      where: "Search the Transfer Market",
      run() {
        const view = [...document.querySelectorAll(".ut-market-search-filters-view")].find(visible);
        const button = view && view.querySelector(".button-container .btn-standard.primary");
        if (button) press(button);
      },
    },
    {
      id: "back",
      defaultCode: "KeyA",
      name: "Back",
      where: "Any screen with the back arrow",
      run() {
        const button = [...document.querySelectorAll(".ut-navigation-button-control")].find(visible);
        if (button) press(button);
      },
    },
    {
      id: "buyLast",
      defaultCode: "KeyG",
      name: "Buy Now, last card",
      where: "Transfer Market search results; buys at once",
      run: () => buyAt("last"),
    },
    {
      id: "buyFirst",
      defaultCode: "KeyH",
      name: "Buy Now, first card",
      where: "Transfer Market search results; buys at once",
      run: () => buyAt("first"),
    },
  ];
  const defaults = () => Object.fromEntries(SHORTCUTS.map((s) => [s.id, s.defaultCode]));
  let bindings = defaults();

  // Saved keys, through storage-bridge.js; resolves with the stored bindings, or null if it does not answer.
  const bridge = (type, shortcuts) =>
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
        resolve(event.data.shortcuts);
      };
      window.addEventListener("message", onReply);
      window.postMessage({ source: "fc27-page", id, type, shortcuts }, location.origin);
    });

  bridge("shortcuts:get").then((saved) => {
    // Keys saved for shortcuts that no longer exist are dropped.
    if (saved) bindings = { ...defaults(), ...Object.fromEntries(Object.entries(saved).filter(([id]) => id in bindings)) };
  });

  document.addEventListener(
    "keydown",
    (event) => {
      if (document.getElementById(WINDOW_ID)) return;
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const shortcut = SHORTCUTS.find((s) => bindings[s.id] === event.code);
      if (!shortcut) return;
      event.preventDefault();
      shortcut.run();
    },
    true
  );

  // The Shortcuts window: one row per shortcut with its key and a Change button.
  let capturing = null; // shortcut id waiting for a new key

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  function renderWindow(message) {
    const win = document.getElementById(WINDOW_ID);
    if (!win) return;
    const list = win.querySelector(".fc27-shortcuts-list");
    list.replaceChildren(
      ...SHORTCUTS.map((s) => {
        const row = el("div", "fc27-shortcuts-row");
        const key = el("kbd", capturing === s.id ? "is-waiting" : null, capturing === s.id ? "?" : keyName(bindings[s.id]));
        const text = el("div", "fc27-shortcuts-text");
        text.append(el("div", "fc27-shortcuts-name", s.name), el("div", "fc27-shortcuts-where", capturing === s.id ? "Press a letter or digit, Esc to cancel" : s.where));
        const change = el("button", "fc27-shortcuts-change", capturing === s.id ? "Cancel" : "Change");
        change.type = "button";
        change.addEventListener("click", () => {
          capturing = capturing === s.id ? null : s.id;
          renderWindow();
        });
        row.append(key, text, change);
        return row;
      })
    );
    win.querySelector(".fc27-shortcuts-message").textContent = message || "";
  }

  async function save(next, message) {
    bindings = next;
    const saved = await bridge("shortcuts:set", bindings);
    renderWindow(saved ? message : "Could not save; the keys work until the page reloads.");
  }

  function openWindow() {
    if (document.getElementById(WINDOW_ID)) return;
    capturing = null;
    const backdrop = el("div", "fc27-shortcuts-backdrop");
    backdrop.id = WINDOW_ID;
    const dialog = el("div", "fc27-shortcuts-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "Shortcuts");
    const footer = el("div", "fc27-shortcuts-footer");
    const reset = el("button", "fc27-shortcuts-secondary", "Reset to defaults");
    reset.type = "button";
    reset.addEventListener("click", () => {
      capturing = null;
      save(defaults(), "Default keys restored.");
    });
    const close = el("button", "fc27-shortcuts-primary", "Done");
    close.type = "button";
    close.addEventListener("click", closeWindow);
    footer.append(reset, close);
    dialog.append(
      el("div", "fc27-shortcuts-title", "Shortcuts"),
      el("div", "fc27-shortcuts-where", "Not active while typing in a field."),
      el("div", "fc27-shortcuts-list"),
      el("div", "fc27-shortcuts-message"),
      footer
    );
    backdrop.append(dialog);
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) closeWindow();
    });
    document.body.append(backdrop);
    renderWindow();
  }

  function closeWindow() {
    capturing = null;
    document.getElementById(WINDOW_ID)?.remove();
  }

  // While the window is open, keys either set the shortcut being changed or close the window (Escape).
  document.addEventListener(
    "keydown",
    (event) => {
      if (!document.getElementById(WINDOW_ID)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (capturing) {
          capturing = null;
          renderWindow();
        } else closeWindow();
        return;
      }
      if (!capturing || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      const shortcut = SHORTCUTS.find((s) => s.id === capturing);
      if (!ALLOWED_CODE.test(event.code)) {
        renderWindow("Use a letter or a digit.");
        return;
      }
      const other = SHORTCUTS.find((s) => s.id !== capturing && bindings[s.id] === event.code);
      if (other) {
        renderWindow(`${keyName(event.code)} is already used for ${other.name}.`);
        return;
      }
      capturing = null;
      save({ ...bindings, [shortcut.id]: event.code }, `${shortcut.name} is now ${keyName(event.code)}.`);
    },
    true
  );

  // The menu can be re-rendered, so the entry is put back before "Settings" whenever it is missing.
  function ensureTab() {
    const bar = document.querySelector(".ut-tab-bar");
    if (!bar || bar.querySelector(`.${TAB_CLASS}`)) return;
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `ut-tab-bar-item ${TAB_CLASS}`;
    tab.append(el("span", null, "Shortcuts"));
    tab.addEventListener("click", (event) => {
      event.stopPropagation();
      openWindow();
    });
    bar.insertBefore(tab, bar.querySelector(".icon-settings"));
  }

  new MutationObserver(ensureTab).observe(document.body, { childList: true, subtree: true });
  ensureTab();
})();
