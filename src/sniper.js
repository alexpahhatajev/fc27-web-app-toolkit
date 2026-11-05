// Sniper on Search the Transfer Market: repeats the form's search for a set time, waits between searches, buys
// the last listing found and then, by the After buy setting, lists it at the lowest Buy Now price, sends it to
// the Transfer List or leaves it in Unassigned. Runs in the page world and uses the app's own services
// (search, bid, move, list), so it keeps running while other screens are open.
// Each search uses a copy of the form's criteria with a different Bid Price Min, so EA answers it as a new
// search instead of repeating the last result; listings started below that minimum are not returned.
// It stops at the end of the time, on Stop, or when EA refuses a search, asks for a captcha or a buy fails
// for a reason other than the listing being gone.
(() => {
  const PANEL_CLASS = "fc27-sniper";
  const LIST_DURATION = 3600;
  const BID_VARIANTS = 20;
  // Statuses after which buying is not retried: captcha, too many requests, no coins, session problems.
  // Error code 461 (the listing is gone, someone else bought it) comes with status 403 and is only a miss.
  const STOP_STATUSES = [401, 403, 426, 429, 458, 470, 494, 512, 521];
  const GONE_CODE = 461;

  // What happens to a bought card.
  const AFTER_BUY = [
    { value: "list", label: "List at lowest BIN" },
    { value: "transfer", label: "Send to Transfer List" },
    { value: "keep", label: "Keep in Unassigned" },
  ];
  const settings = { runSeconds: 300, waitSeconds: 3, buy: true, afterBuy: "list" };
  // `message` is the current step, `lastBuy` the outcome of the latest buy, kept until the next one.
  const run = { active: false, endsAt: 0, searches: 0, found: 0, bought: 0, listed: 0, moved: 0, spent: 0, message: "", lastBuy: "", timer: null };

  const fmt = (n) => n.toLocaleString("en-US");
  const sleep = (ms) => new Promise((resolve) => (run.timer = setTimeout(resolve, ms)));
  const call = (observable) =>
    new Promise((resolve) => {
      const scope = {};
      const timer = setTimeout(() => resolve({ success: false, status: 0 }), 15000);
      observable.observe(scope, (o, response) => {
        o.unobserve(scope);
        clearTimeout(timer);
        resolve(response);
      });
    });

  // The search form's controller, kept when its view appears.
  let formController = null;
  const hook = setInterval(() => {
    if (typeof UTMarketSearchFiltersViewController !== "function") return;
    clearInterval(hook);
    const proto = UTMarketSearchFiltersViewController.prototype;
    const viewDidAppear = proto.viewDidAppear;
    proto.viewDidAppear = function () {
      formController = this;
      return viewDidAppear.apply(this, arguments);
    };
  }, 200);

  function formCriteria() {
    const source = formController && formController.viewmodel && formController.viewmodel.searchCriteria;
    if (!source) return null;
    const criteria = new UTSearchCriteriaDTO();
    criteria.update(source);
    return criteria;
  }

  // Bid Price Min values: the form's own minimum, then the next steps above it, all below Buy Now Max.
  function bidVariants(criteria) {
    const values = [criteria.minBid || 0];
    while (values.length < BID_VARIANTS) {
      const last = values[values.length - 1];
      const next = last > 0 ? UTCurrencyInputControl.getIncrementAboveVal(last) : 150;
      if (criteria.maxBuy && next >= criteria.maxBuy) break;
      if (criteria.maxBid && next > criteria.maxBid) break;
      values.push(next);
    }
    return values;
  }

  const failure = (what, response) => `${what} failed (status ${response.status || "none"}${response.error && response.error.code ? ", code " + response.error.code : ""})`;

  async function buyAndSell(listing) {
    const price = listing.getAuctionData().buyNowPrice;
    const bid = await call(services.Item.bid(listing, price));
    if (!bid.success) {
      const gone = bid.error && Number(bid.error.code) === GONE_CODE;
      if (!gone && STOP_STATUSES.includes(bid.status)) return failure("Buy", bid);
      run.lastBuy = `Missed one at ${fmt(price)}: ${failure("buy", bid)}`;
      return null;
    }
    run.bought++;
    run.spent += price;
    run.lastBuy = `Bought for ${fmt(price)}`;
    if (settings.afterBuy === "keep") return null;
    if (settings.afterBuy === "transfer") {
      const moved = await call(services.Item.move(listing, ItemPile.TRANSFER));
      if (moved.success) run.moved++;
      run.lastBuy = moved.success ? `Bought for ${fmt(price)}, sent to Transfer List` : `Bought for ${fmt(price)}; ${failure("send to Transfer List", moved)}`;
      return null;
    }

    run.message = "Checking the lowest Buy Now...";
    render();
    const check = await window.fc27FindLowest(listing, (text) => {
      run.message = `Lowest Buy Now: ${text}`;
      render();
    });
    if (!check.lowest) {
      run.lastBuy = `Bought for ${fmt(price)}; not listed: ${check.error || "no other listings to price it by"}`;
      return null;
    }
    const start = UTCurrencyInputControl.getIncrementBelowVal(check.lowest);
    const listed = await call(services.Item.list(listing, start, check.lowest, LIST_DURATION));
    if (!listed.success) {
      run.lastBuy = `Bought for ${fmt(price)}; ${failure("listing", listed)}`;
      return null;
    }
    run.listed++;
    run.message = "";
    run.lastBuy = `Bought for ${fmt(price)}, listed at ${fmt(check.lowest)} (start ${fmt(start)})`;
    return null;
  }

  async function loop() {
    const base = formCriteria();
    const variants = bidVariants(base);
    while (run.active && Date.now() < run.endsAt) {
      const criteria = formCriteria() || base;
      criteria.minBid = variants[run.searches % variants.length];
      services.Item.clearTransferMarketCache();
      const response = await call(services.Item.searchTransferMarket(criteria, 1));
      run.searches++;
      if (!response.success) return stop(failure("Search", response));
      const listings = ((response.data && response.data.items) || []).filter((item) => {
        const auction = item.getAuctionData();
        return !auction.tradeOwner && auction.buyNowPrice > 0 && (!criteria.maxBuy || auction.buyNowPrice <= criteria.maxBuy);
      });
      run.found += listings.length;
      run.message = listings.length ? `${listings.length} found` : "Nothing found";
      if (listings.length && settings.buy) {
        const stopReason = await buyAndSell(listings[listings.length - 1]);
        if (stopReason) return stop(stopReason);
      }
      render();
      if (Date.now() + settings.waitSeconds * 1000 >= run.endsAt) break;
      await sleep(settings.waitSeconds * 1000);
    }
    if (run.active) stop("Time is up");
  }

  function start() {
    const criteria = formCriteria();
    if (!criteria) return showMessage("Open Search the Transfer Market first.");
    // Without a price cap a found listing could cost anything.
    if (settings.buy && !(criteria.maxBuy > 0)) return showMessage("Set Buy Now Price Max before buying.");
    Object.assign(run, { active: true, endsAt: Date.now() + settings.runSeconds * 1000, searches: 0, found: 0, bought: 0, listed: 0, moved: 0, spent: 0, message: "Starting...", lastBuy: "" });
    render();
    loop();
  }

  function stop(message) {
    run.active = false;
    clearTimeout(run.timer);
    if (message) run.message = message;
    render();
  }

  function showMessage(text) {
    run.message = text;
    render();
  }

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  function numberField(label, key, min, max) {
    const wrap = el("label", "fc27-sniper-field");
    const input = el("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.value = String(settings[key]);
    input.addEventListener("change", () => {
      const value = Math.round(Number(input.value));
      settings[key] = Math.min(max, Math.max(min, Number.isFinite(value) ? value : settings[key]));
      input.value = String(settings[key]);
    });
    wrap.append(el("span", null, label), input);
    return wrap;
  }

  function checkField(label, key) {
    const wrap = el("label", "fc27-sniper-check");
    const input = el("input");
    input.type = "checkbox";
    input.checked = settings[key];
    input.addEventListener("change", () => (settings[key] = input.checked));
    wrap.append(input, el("span", null, label));
    return wrap;
  }

  function selectField(label, key, options) {
    const wrap = el("label", "fc27-sniper-field");
    const select = el("select");
    for (const option of options) {
      const node = el("option", null, option.label);
      node.value = option.value;
      select.append(node);
    }
    select.value = settings[key];
    select.addEventListener("change", () => (settings[key] = select.value));
    wrap.append(el("span", null, label), select);
    return wrap;
  }

  function build(panel) {
    const button = el("button", "btn-standard fc27-sniper-start");
    button.type = "button";
    button.addEventListener("click", () => (run.active ? stop("Stopped") : start()));
    const row = el("div", "fc27-sniper-row");
    row.append(
      el("span", "fc27-sniper-title", "Sniper"),
      numberField("Run (s)", "runSeconds", 10, 3600),
      numberField("Wait (s)", "waitSeconds", 1, 60),
      checkField("Buy last found", "buy"),
      selectField("After buy", "afterBuy", AFTER_BUY),
      button
    );
    panel.append(row, el("div", "fc27-sniper-status"));
  }

  function render() {
    for (const panel of document.querySelectorAll(`.${PANEL_CLASS}`)) {
      panel.classList.toggle("is-running", run.active);
      panel.querySelector(".fc27-sniper-start").textContent = run.active ? "Stop" : "Start";
      for (const input of panel.querySelectorAll("input, select")) input.disabled = run.active;
      const left = Math.max(0, Math.ceil((run.endsAt - Date.now()) / 1000));
      const counts = run.searches
        ? `${run.searches} searches · ${run.found} found · ${run.bought} bought (${fmt(run.spent)})` +
          (run.listed ? ` · ${run.listed} listed` : "") +
          (run.moved ? ` · ${run.moved} to Transfer List` : "")
        : "";
      panel.querySelector(".fc27-sniper-status").textContent = [run.active ? `${left}s left` : "", counts, run.message, run.lastBuy].filter(Boolean).join(" · ");
    }
  }

  // The panel sits above the form's Reset and Search buttons and is put back when the app re-renders the form.
  function ensurePanel() {
    for (const view of document.querySelectorAll(".ut-market-search-filters-view")) {
      const buttons = view.querySelector(".ut-content > .button-container");
      if (!buttons || view.querySelector(`.${PANEL_CLASS}`)) continue;
      const panel = el("div", PANEL_CLASS);
      build(panel);
      buttons.parentElement.insertBefore(panel, buttons);
      render();
    }
  }

  new MutationObserver(ensurePanel).observe(document.body, { childList: true, subtree: true });
  setInterval(() => run.active && render(), 1000);
})();
