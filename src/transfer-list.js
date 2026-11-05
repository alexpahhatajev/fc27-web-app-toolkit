// Profit on your own listings (Transfer List: active and sold): the price after EA's 5% tax minus what you
// paid for the card; a card from a pack or reward cost 0. A sold card uses its final price, an active listing
// its Buy Now price. Runs in the page world and hooks the app's list row (UTItemTableCellView); content.css
// colors the row green or red and sets the layout.
// The paid price is item.lastSalePrice, which EA returns as 0 once the card is sold, so it is saved per item
// id (storage-bridge.js "paid:*") while the card is listed and read back for the sold card.
(() => {
  const TAX = 0.05;
  const LABEL_CLASS = "fc27-profit";

  const fmt = (n) => Math.abs(n).toLocaleString("en-US");

  const bridge = (type, paid) =>
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
        resolve(event.data.paid);
      };
      window.addEventListener("message", onReply);
      window.postMessage({ source: "fc27-page", id, type, paid }, location.origin);
    });

  const paidPrices = {};
  bridge("paid:get").then((saved) => Object.assign(paidPrices, saved || {}));

  // New prices are saved together once the rows of a screen are drawn.
  const unsaved = {};
  let saveTimer = null;
  function rememberPaid(item) {
    const price = item.lastSalePrice || 0;
    if (paidPrices[item.id] === price) return;
    paidPrices[item.id] = unsaved[item.id] = price;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const batch = { ...unsaved };
      for (const id of Object.keys(batch)) delete unsaved[id];
      bridge("paid:merge", batch);
    }, 1000);
  }

  function profitOf(item) {
    if (!item || typeof item.getAuctionData !== "function") return null;
    const auction = item.getAuctionData();
    if (!auction || !auction.tradeOwner) return null;
    const sold = auction.isSold();
    if (!sold && !auction.isActiveTrade()) return null;
    // A listed card shows its true buy price, 0 for a card from a pack or reward, and that is saved. A sold card
    // has 0 either way, so only a saved price counts; without one the profit is unknown.
    if (!sold) rememberPaid(item);
    const paid = sold ? (item.lastSalePrice > 0 ? item.lastSalePrice : paidPrices[item.id]) : item.lastSalePrice || 0;
    if (paid == null) return null;
    const price = sold ? auction.currentBid : auction.buyNowPrice;
    if (!(price > 0)) return null;
    return { sold, value: Math.floor(price * (1 - TAX)) - paid, paid, price };
  }

  function decorate(cell) {
    const root = cell.getRootElement && cell.getRootElement();
    if (!root) return;
    const profit = profitOf(cell.getData && cell.getData());
    let label = root.querySelector(`.${LABEL_CLASS}`);
    root.classList.toggle("fc27-profit-up", !!profit && profit.value >= 0);
    root.classList.toggle("fc27-profit-down", !!profit && profit.value < 0);
    if (!profit) {
      if (label) label.remove();
      return;
    }
    if (!label) {
      label = document.createElement("span");
      label.className = LABEL_CLASS;
      (root.querySelector(".rowContent") || root).append(label);
    }
    label.textContent = `${profit.value >= 0 ? "+" : "−"}${fmt(profit.value)}`;
    label.title =
      `${profit.sold ? "Sold for" : "Buy Now"} ${profit.price.toLocaleString("en-US")}, ` +
      `${fmt(Math.floor(profit.price * (1 - TAX)))} after 5% tax, ` +
      (profit.paid ? `bought for ${profit.paid.toLocaleString("en-US")}.` : "from a pack or reward (no buy price).");
  }

  const ready = setInterval(() => {
    if (typeof UTItemTableCellView !== "function") return;
    clearInterval(ready);
    const proto = UTItemTableCellView.prototype;
    // render draws the row; _renderAuctionState redraws it when the auction changes (a bid, sold, expired).
    for (const name of ["render", "_renderAuctionState"]) {
      const original = proto[name];
      if (typeof original !== "function") continue;
      proto[name] = function () {
        const result = original.apply(this, arguments);
        try {
          decorate(this);
        } catch (e) {
          // Leave the row as the app drew it.
        }
        return result;
      };
    }
  }, 200);
})();
