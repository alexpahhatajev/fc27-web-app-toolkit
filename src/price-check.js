// "Lowest BIN" box in the item panel of tradeable cards (club, squad, transfer list).
// Runs in the page world. A check runs only on a click and uses the app's own market search:
// search with Max Buy Now = cap, take the cheapest listing m, search again below m, until a search is empty;
// the last m is the lowest Buy Now price. EA returns 21 listings per page in time order, not by price.
(() => {
  const BOX_CLASS = "fc27-price";
  const MAX_SEARCHES = 6;
  const PAUSE_MS = 1200;
  const CACHE_MS = 5 * 60 * 1000;
  const TAX = 0.05;
  const results = new Map(); // definitionId -> { lowest, count, checkedAt, searches } or { none, checkedAt }
  let busy = false;

  const fmt = (n) => n.toLocaleString("en-US");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const below = (price) => UTCurrencyInputControl.getIncrementBelowVal(price);

  // One market search for this card; maxBuy 0 means no limit. Resolves with other sellers' Buy Now prices.
  function search(item, maxBuy) {
    return new Promise((resolve) => {
      const criteria = new UTSearchCriteriaDTO();
      criteria.defId = [item.definitionId];
      criteria.type = item.getSearchType();
      criteria.maxBuy = maxBuy;
      services.Item.clearTransferMarketCache();
      const scope = {};
      const timer = setTimeout(() => resolve({ error: "no answer from EA" }), 15000);
      services.Item.searchTransferMarket(criteria, 1).observe(scope, (observable, response) => {
        observable.unobserve(scope);
        clearTimeout(timer);
        if (!response.success) {
          const code = response.error && response.error.code;
          resolve({ error: `EA refused the search (status ${response.status}${code ? ", code " + code : ""})` });
          return;
        }
        const prices = ((response.data && response.data.items) || [])
          .map((listing) => listing.getAuctionData())
          .filter((auction) => !auction.tradeOwner && auction.buyNowPrice > 0)
          .map((auction) => auction.buyNowPrice);
        resolve({ prices });
      });
    });
  }

  async function findLowest(item, onProgress) {
    let searches = 0;
    const run = async (maxBuy) => {
      if (searches > 0) await sleep(PAUSE_MS);
      searches++;
      onProgress(`Search ${searches}${maxBuy ? `, max ${fmt(maxBuy)}` : ""}...`);
      return search(item, maxBuy);
    };

    // EA's market average (recent sales) is not shown, but it is a good first cap: below it there are
    // often listings, which saves a search; if not, the next search has no cap.
    const average = item._marketAverage > 0 ? item._marketAverage : 0;
    let page = await run(average);
    if (!page.error && !page.prices.length && average) page = await run(0);
    if (page.error) return { error: page.error, searches };
    if (!page.prices.length) return { none: true, searches };

    let lowest = Math.min(...page.prices);
    let count = page.prices.filter((p) => p === lowest).length;
    while (searches < MAX_SEARCHES) {
      const cap = below(lowest);
      if (!(cap > 0)) break;
      page = await run(cap);
      if (page.error) return { error: page.error, searches, lowest, count, partial: true };
      if (!page.prices.length) return { lowest, count, searches };
      lowest = Math.min(...page.prices);
      count = page.prices.filter((p) => p === lowest).length;
    }
    // Search limit reached while cheaper listings still existed.
    return { lowest, count, searches, partial: true };
  }

  // Also used by sniper.js to price a card it bought.
  window.fc27FindLowest = findLowest;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  // Result first (price in bold), button below; both centered like the panel's own info above its actions.
  function renderBox(box, item) {
    const result = results.get(item.definitionId);
    const fresh = result && Date.now() - result.checkedAt < CACHE_MS;
    const area = box.querySelector(".fc27-price-result");
    const parts = [];
    if (result && result.lowest) {
      const at = new Date(result.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      parts.push(el("div", "fc27-price-label", "Lowest BIN"));
      const price = el("div", "fc27-price-value", fmt(result.lowest));
      if (result.partial) price.append(el("span", "fc27-price-note", " or less"));
      parts.push(price);
      parts.push(el("div", "fc27-price-meta", `${result.count} listed at this price \u00b7 checked ${at}`));
      const list = below(result.lowest);
      if (list > 0) {
        const sell = el("div", "fc27-price-sell", "List at ");
        sell.append(el("b", null, fmt(list)), " \u2192 you get ", el("b", null, fmt(Math.floor(list * (1 - TAX)))), " after 5% tax");
        parts.push(sell);
      }
    }
    if (result && result.none) parts.push(el("div", "fc27-price-meta", "No other listings found."));
    if (result && result.error) parts.push(el("div", "fc27-price-error", result.error + "."));
    area.replaceChildren(...parts);
    area.hidden = !parts.length;
    // A fresh result is shown instead of searching again; the button returns when it expires.
    const button = box.querySelector("button");
    button.disabled = busy || fresh;
    button.textContent = busy ? "Checking..." : fresh ? `Next check ${new Date(result.checkedAt + CACHE_MS).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : result ? "Check again" : "Lowest BIN";
    clearTimeout(box.__fc27Timer);
    if (fresh && !busy) box.__fc27Timer = setTimeout(() => box.__fc27Item === item && renderBox(box, item), result.checkedAt + CACHE_MS - Date.now());
  }

  function decorate(root, item) {
    if (!root) return;
    let box = root.querySelector(`:scope > .${BOX_CLASS}`);
    if (!item || !item.tradable || !item.definitionId || typeof item.getSearchType !== "function") {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = document.createElement("div");
      box.className = BOX_CLASS;
      box.innerHTML = '<div class="fc27-price-result" hidden></div><button type="button"></button>';
      root.prepend(box);
    }
    box.__fc27Item = item;
    const button = box.querySelector("button");
    button.onclick = async (event) => {
      event.stopPropagation();
      const current = box.__fc27Item;
      if (busy || !current) return;
      busy = true;
      renderBox(box, current);
      const result = await findLowest(current, (text) => {
        if (box.__fc27Item !== current) return;
        const area = box.querySelector(".fc27-price-result");
        area.replaceChildren(el("div", "fc27-price-meta", text));
        area.hidden = false;
      });
      results.set(current.definitionId, { ...result, checkedAt: Date.now() });
      busy = false;
      if (box.__fc27Item === current) renderBox(box, current);
      refreshFillButtons(box.closest(".DetailPanel"));
    };
    renderBox(box, item);
    refreshFillButtons(root.closest(".DetailPanel"));
  }

  // "Use lowest BIN" inside List on Transfer Market: fills Buy Now with the last lowest BIN and Start Price with
  // the next price step below, through the panel's own setters (they keep EA's limits and start < Buy Now).
  // The listing itself stays the user's click on the app's own button.
  const FILL_CLASS = "fc27-fill";

  function panelItem(quickListRoot) {
    const panel = quickListRoot.closest(".DetailPanel");
    const box = panel && panel.querySelector(`.${BOX_CLASS}`);
    return box && box.__fc27Item;
  }

  function updateFillButton(view) {
    const root = view.getRootElement();
    const button = root && root.querySelector(`.${FILL_CLASS}`);
    if (!button) return;
    const item = panelItem(root);
    const result = item && results.get(item.definitionId);
    const start = result && result.lowest ? below(result.lowest) : 0;
    button.disabled = !(result && result.lowest && start > 0);
    button.textContent = button.disabled
      ? "Check the lowest BIN first"
      : `Fill: Buy Now ${fmt(result.lowest)} · Start ${fmt(start)}`;
    button.title = button.disabled ? "" : "Fills the price fields from the last lowest BIN check. Listing stays your click.";
  }

  function ensureFillButton(view) {
    const root = view.getRootElement();
    const actions = root && root.querySelector(".panelActions");
    if (!actions) return;
    root.__fc27View = view;
    if (!actions.querySelector(`.${FILL_CLASS}`)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = FILL_CLASS;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const item = panelItem(root);
        const result = item && results.get(item.definitionId);
        if (!result || !result.lowest) return;
        view.setBuyNowValue(result.lowest);
        view.setBidValue(below(result.lowest));
      });
      actions.prepend(button);
    }
    updateFillButton(view);
  }

  function refreshFillButtons(panel) {
    if (!panel) return;
    panel.querySelectorAll(".ut-quick-list-panel-view").forEach((root) => root.__fc27View && updateFillButton(root.__fc27View));
  }

  function hookQuickList() {
    const proto = window.UTQuickListPanelView && window.UTQuickListPanelView.prototype;
    if (!proto) return;
    for (const method of ["init", "toggle", "open"]) {
      const original = proto[method];
      if (typeof original !== "function") continue;
      proto[method] = function () {
        const result = original.apply(this, arguments);
        try {
          ensureFillButton(this);
        } catch (e) {
          // Never break the app's own panel.
        }
        return result;
      };
    }
  }

  // The action panels that show a player you own: club lists, squad slots, transfer list.
  function hook(cls, method) {
    const proto = cls && cls.prototype;
    if (!proto || typeof proto[method] !== "function") return;
    const original = proto[method];
    proto[method] = function (item) {
      const result = original.apply(this, arguments);
      try {
        decorate(this.getRootElement(), item);
      } catch (e) {
        // Never break the app's own panel.
      }
      return result;
    };
  }

  const ready = setInterval(() => {
    if (window.UTDefaultActionPanelView && window.UTSearchCriteriaDTO && window.UTCurrencyInputControl && window.services) {
      clearInterval(ready);
      hook(window.UTDefaultActionPanelView, "render");
      hook(window.UTSlotActionPanelView, "setItem");
      hook(window.UTTransferActionPanelView, "render");
      hookQuickList();
    }
  }, 200);
})();
