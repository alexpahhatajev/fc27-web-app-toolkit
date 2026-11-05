// Sniper on Search the Transfer Market: repeats the form's search for a set time, waits between searches, buys
// the last listing found and then, by the After buy setting, lists it at the lowest Buy Now price, sends it to
// the Transfer List or leaves it in Unassigned. Runs in the page world and uses the app's own services
// (search, bid, move, list), so it keeps running while other screens are open.
// Each search uses a copy of the form's criteria with a different Bid Price Min, so EA answers it as a new
// search instead of repeating the last result; listings started below that minimum are not returned.
// It stops at the end of the time, on Stop, or when EA refuses a search, asks for a captcha or a buy fails
// for a reason other than the listing being gone.
// Rating Min/Max: EA's market search has no rating filter (the app drops ovrMin/ovrMax from the request), so
// the range is applied here: Search Results hides cards outside it (content.css) and the sniper skips them.
// "By player" searches the players whose card has a rating in the range, taken in turn from the app's player
// database (regular cards; a special card rated higher than the player's own is missed). A search from the form
// skips players without a listing in range, up to PLAYER_SKIP of them per press.
// With a Rating Min of 75 or more and no Quality in the form, searches are Gold only. "Find cheapest" looks for
// the lowest Buy Now in the Rating range.
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
  // ratingMin / ratingMax: 0 means no limit.
  // ratingOn switches the whole Rating row on or off; while off, nothing of it applies.
  const settings = { runSeconds: 300, waitSeconds: 3, buy: true, afterBuy: "list", ratingOn: false, ratingMin: 0, ratingMax: 0, byPlayer: false };
  const ratingActive = () => settings.ratingOn && !!(settings.ratingMin || settings.ratingMax);
  const ratingOk = (item) =>
    !ratingActive() ||
    ((!settings.ratingMin || item.rating >= settings.ratingMin) && (!settings.ratingMax || item.rating <= settings.ratingMax));
  const byPlayerOn = () => settings.byPlayer && ratingActive();
  const rangeText = () =>
    settings.ratingMin && settings.ratingMin === settings.ratingMax
      ? String(settings.ratingMin)
      : `${settings.ratingMin || "any"} to ${settings.ratingMax || "any"}`;

  // A rating of 75 or more is never bronze or silver, so a form without a Quality searches Gold only; otherwise
  // the newest cheap listings are nearly all bronze and silver cards.
  const goldOnly = (criteria) => ratingActive() && settings.ratingMin >= 75 && (!criteria.level || criteria.level === "any");
  function withRatingFilters(criteria) {
    if (goldOnly(criteria)) criteria.level = "gold";
    return criteria;
  }

  // Another seller's player in the Rating range, at or under the Buy Now cap.
  function inRange(item, maxBuy) {
    const auction = item.getAuctionData();
    return !auction.tradeOwner && auction.buyNowPrice > 0 && (!maxBuy || auction.buyNowPrice <= maxBuy) && ratingOk(item);
  }
  const playerName = (p) => p.commonName || `${p.firstName} ${p.lastName}`;

  // Players in the rating range, highest rated first; the turn starts again when the range changes.
  let players = { key: "", list: [], turn: 0 };
  function nextPlayer() {
    const min = settings.ratingMin || 40;
    const max = settings.ratingMax || 99;
    const key = `${min}-${max}`;
    if (players.key !== key) {
      const all = Object.values(repositories.Item.staticData._collection);
      const list = all.filter((p) => p.rating >= min && p.rating <= max).sort((a, b) => b.rating - a.rating || a.id - b.id);
      players = { key, list, turn: 0 };
    }
    // Players saved as not on market are passed over; `skipped` counts them for the messages.
    let skipped = 0;
    for (let n = 0; n < players.list.length; n++) {
      const index = players.turn % players.list.length;
      players.turn++;
      const player = players.list[index];
      if (offMarket[player.id]) {
        skipped++;
        continue;
      }
      return { player, index: index + 1, count: players.list.length, skipped };
    }
    return null;
  }

  // Players with no listing at all (cards that cannot be traded or are not on the market), saved through
  // storage-bridge.js for 7 days, so By player does not spend searches on them.
  const offMarket = {};
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
        resolve(event.data.offMarket);
      };
      window.addEventListener("message", onReply);
      window.postMessage({ source: "fc27-page", id, type, offMarket: data }, location.origin);
    });
  bridge("offmarket:get").then((saved) => Object.assign(offMarket, saved || {}));
  function markOffMarket(player) {
    offMarket[player.id] = Date.now();
    bridge("offmarket:merge", { [player.id]: offMarket[player.id] });
  }
  let currentPlayer = null; // the player of the latest search from the form, for the note above the results
  let finding = false; // a By player check or Find cheapest is running

  const PLAYER_SKIP = 10;
  const PLAYER_PAUSE_MS = 1000;

  // One market search with the form's filters plus the Rating ones; resolves with the listings in range, or an error.
  async function searchInRange(source, changes) {
    const criteria = new UTSearchCriteriaDTO();
    criteria.update(source);
    withRatingFilters(Object.assign(criteria, changes));
    services.Item.clearTransferMarketCache();
    const response = await call(services.Item.searchTransferMarket(criteria, 1));
    if (!response.success) return { error: failure("Search", response) };
    return { listings: ((response.data && response.data.items) || []).filter((item) => inRange(item, criteria.maxBuy)) };
  }

  // By player from the form: the next player (in turn) with at least one listing in range, at most PLAYER_SKIP
  // players per press, one market search each. A player without a listing in range is searched once more
  // without any price or rating limit; with no listing at all he is saved as not on market.
  async function findPlayerWithListings(criteria) {
    finding = true;
    let first = null;
    let last = null;
    let skipped = 0;
    let saved = 0;
    const pause = () => new Promise((resolve) => setTimeout(resolve, PLAYER_PAUSE_MS));
    try {
      for (let n = 0; n < PLAYER_SKIP; n++) {
        const turn = nextPlayer();
        if (!turn) {
          showMessage("No player in the rating range is on the market.");
          return null;
        }
        first = first || turn;
        last = turn;
        skipped += turn.skipped;
        showMessage(`By player: checking ${playerName(turn.player)} (${turn.index} of ${turn.count})...`);
        if (n > 0) await pause();
        const page = await searchInRange(criteria, { maskedDefId: turn.player.id });
        if (page.error) {
          showMessage(page.error);
          return null;
        }
        if (page.listings.length) {
          showMessage(`By player: ${playerName(turn.player)} has ${page.listings.length} in range` + (skipped ? ` · ${skipped} not on market skipped` : ""));
          return turn;
        }
        await pause();
        const any = await anyListing(turn.player);
        if (any.error) {
          showMessage(any.error);
          return null;
        }
        if (!any.count) {
          markOffMarket(turn.player);
          saved++;
        }
      }
      const notes = [skipped && `${skipped} not on market skipped`, saved && `${saved} newly saved as not on market`].filter(Boolean);
      showMessage(
        `By player: no listing in range for players ${first.index} to ${last.index} of ${last.count}` +
          (notes.length ? ` · ${notes.join(" · ")}` : "") +
          "; press Search to go on"
      );
      return null;
    } finally {
      finding = false;
      render();
    }
  }

  // One market search for a player with no other filter; resolves with the number of listings on the page.
  async function anyListing(player) {
    const criteria = new UTSearchCriteriaDTO();
    criteria.type = SearchType.PLAYER;
    criteria.maskedDefId = player.id;
    services.Item.clearTransferMarketCache();
    const response = await call(services.Item.searchTransferMarket(criteria, 1));
    if (!response.success) return { error: failure("Search", response) };
    return { count: ((response.data && response.data.items) || []).length };
  }

  // Find cheapest: the lowest Buy Now in the Rating range with the form's other filters. EA lists newest first,
  // not by price, so the cap rises until a page holds a match, then drops below the cheapest match until a page
  // holds none. At most FIND_SEARCHES market searches.
  const FIND_SEARCHES = 8;
  const FIND_PAUSE_MS = 1500;
  function raise(cap) {
    const next = cap * 1.25;
    const step = next < 1000 ? 50 : next < 10000 ? 100 : next < 50000 ? 250 : next < 100000 ? 500 : 1000;
    return Math.ceil(next / step) * step;
  }

  async function findCheapest() {
    const base = formCriteria();
    if (!base) return showMessage("Open Search the Transfer Market first.");
    if (!ratingActive()) return showMessage("Turn Rating on and set a range first.");
    finding = true;
    let searches = 0;
    let cap = base.maxBuy > 0 ? base.maxBuy : 1000;
    let lowest = null;
    let count = 0;
    const search = async (maxBuy) => {
      if (searches) await new Promise((resolve) => setTimeout(resolve, FIND_PAUSE_MS));
      searches++;
      showMessage(`Find cheapest ${rangeText()}: search ${searches}, Buy Now up to ${fmt(maxBuy)}...`);
      const page = await searchInRange(base, { minBuy: 0, maxBuy, minBid: 0, maxBid: 0 });
      return page.error ? page : { prices: page.listings.map((item) => item.getAuctionData().buyNowPrice) };
    };
    let page = await search(cap);
    while (!page.error && !page.prices.length && searches < FIND_SEARCHES) {
      cap = raise(cap);
      page = await search(cap);
    }
    while (!page.error && page.prices.length) {
      lowest = Math.min(...page.prices);
      count = page.prices.filter((price) => price === lowest).length;
      const below = UTCurrencyInputControl.getIncrementBelowVal(lowest);
      if (searches >= FIND_SEARCHES || !(below > 0)) break;
      page = await search(below);
    }
    finding = false;
    const found = lowest ? `cheapest ${rangeText()}: ${fmt(lowest)} (${count} at that price)` : `no ${rangeText()} found up to ${fmt(cap)}`;
    showMessage(`Find cheapest: ${found}${page.error ? `; stopped, ${page.error}` : ""} · ${searches} searches`);
  }

  // `message` is the current step, `lastBuy` the outcome of the latest buy, kept until the next one.
  const run = { active: false, endsAt: 0, searches: 0, found: 0, bought: 0, listed: 0, moved: 0, spent: 0, offMarket: 0, message: "", lastBuy: "", timer: null };

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

  // The search form's controller, kept when its view appears. Every list row remembers its item, so the rating
  // range can be applied again when it changes.
  let formController = null;
  const rowItems = new WeakMap();
  const hook = setInterval(() => {
    if (typeof UTMarketSearchFiltersViewController !== "function" || typeof UTItemTableCellView !== "function") return;
    clearInterval(hook);
    const proto = UTMarketSearchFiltersViewController.prototype;
    const viewDidAppear = proto.viewDidAppear;
    proto.viewDidAppear = function () {
      formController = this;
      return viewDidAppear.apply(this, arguments);
    };
    // A search from the form is Gold only where goldOnly says so, and may page on by itself when its pages hold
    // no listing in the Rating range. In By player mode (while no player is set in the form) it first finds the
    // next player with a listing in range, then the app searches that player. The form keeps its own values.
    const eSearchSelected = proto.eSearchSelected;
    proto.eSearchSelected = function () {
      const controller = this;
      const args = arguments;
      const criteria = this.viewmodel && this.viewmodel.searchCriteria;
      if (!criteria || finding) return eSearchSelected.apply(this, args);
      const searchWith = (turn) => {
        currentPlayer = turn;
        autoPages = turn ? 0 : AUTO_PAGES;
        pagesChecked = 1;
        const { level, maskedDefId } = criteria;
        withRatingFilters(criteria);
        if (turn) criteria.maskedDefId = turn.player.id;
        try {
          return eSearchSelected.apply(controller, args);
        } finally {
          criteria.level = level;
          criteria.maskedDefId = maskedDefId;
        }
      };
      if (!byPlayerOn() || criteria.maskedDefId > 0) return searchWith(null);
      findPlayerWithListings(criteria).then((turn) => turn && searchWith(turn));
    };
    const render = UTItemTableCellView.prototype.render;
    UTItemTableCellView.prototype.render = function () {
      const result = render.apply(this, arguments);
      try {
        const root = this.getRootElement();
        rowItems.set(root, this.getData());
        markRating(root);
        scheduleNote();
      } catch (e) {
        // Leave the row as the app drew it.
      }
      return result;
    };
  }, 200);

  // Other sellers' players outside the range are marked; content.css hides them in Search Results only.
  function markRating(root) {
    const item = rowItems.get(root);
    const auction = item && typeof item.getAuctionData === "function" ? item.getAuctionData() : null;
    root.classList.toggle("fc27-rating-out", !!auction && !auction.tradeOwner && typeof item.isPlayer === "function" && item.isPlayer() && !ratingOk(item));
  }

  // The app's rows react to a mouse press and release, not to a plain click().
  function press(target) {
    const r = target.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    target.dispatchEvent(new MouseEvent("mousedown", init));
    target.dispatchEvent(new MouseEvent("mouseup", init));
  }

  // A line above the results says how many of the page's listings match the range. The app selects the first
  // listing for the side panel; when that one is hidden, the first shown listing is selected instead.
  // When a page has no match, the next page is opened (each one a market search), at most AUTO_PAGES times per
  // search; turning a page by hand ends that.
  const AUTO_PAGES = 5;
  let autoPages = 0;
  let pagesChecked = 1;
  let autoTimer = null;
  document.addEventListener(
    "mouseup",
    (event) => {
      if (event.isTrusted && event.target.closest && event.target.closest(".SearchResults .pagination")) autoPages = 0;
    },
    true
  );

  let notePending = false;
  function scheduleNote() {
    if (notePending) return;
    notePending = true;
    requestAnimationFrame(() => {
      notePending = false;
      for (const list of document.querySelectorAll(".SearchResults .paginated-item-list")) {
        let note = list.querySelector(":scope > .fc27-rating-note");
        const rows = list.querySelectorAll(".listFUTItem");
        const active = ratingActive();
        if (!active || !rows.length) {
          if (note) note.remove();
          list.closest(".SearchResults").classList.remove("fc27-rating-empty");
          continue;
        }
        if (!note) {
          note = el("div", "fc27-rating-note");
          list.prepend(note);
        }
        const shown = [...rows].filter((row) => !row.classList.contains("fc27-rating-out"));
        let text = `Rating ${settings.ratingMin || "any"} to ${settings.ratingMax || "any"}: ${shown.length} of ${rows.length} shown`;
        if (currentPlayer) {
          const p = currentPlayer.player;
          text = `Player ${currentPlayer.index} of ${currentPlayer.count}: ${playerName(p)} (${p.rating}) · ${text}`;
          if (!shown.length) text += " · press Search again for the next player";
        }
        const next = list.querySelector(".pagination.next");
        if (!shown.length && autoPages > 0 && next && next.offsetParent && !next.disabled) {
          text += ` · no match, opening page ${pagesChecked + 1}...`;
          if (!autoTimer) {
            autoPages--;
            autoTimer = setTimeout(() => {
              autoTimer = null;
              pagesChecked++;
              press(next);
            }, 1000);
          }
        } else if (!shown.length && pagesChecked > 1) {
          text += ` · no match on ${pagesChecked} pages; add Quality, Rarity or Position to narrow the search`;
        }
        note.textContent = text;
        // With nothing shown, the side panel (the app's pick of a hidden listing) is hidden too (content.css).
        list.closest(".SearchResults").classList.toggle("fc27-rating-empty", !shown.length);
        const selected = list.querySelector(".listFUTItem.selected");
        if (shown.length && selected && selected.classList.contains("fc27-rating-out")) press(shown[0].querySelector(".rowContent") || shown[0]);
      }
    });
  }

  function applyRating() {
    for (const row of document.querySelectorAll(".listFUTItem")) if (rowItems.has(row)) markRating(row);
    scheduleNote();
  }

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
      const criteria = withRatingFilters(formCriteria() || base);
      criteria.minBid = variants[run.searches % variants.length];
      let turn = null;
      if (byPlayerOn() && !(criteria.maskedDefId > 0)) {
        turn = nextPlayer();
        if (!turn) return stop("No player in the rating range is on the market.");
        criteria.maskedDefId = turn.player.id;
        run.message = `Player ${turn.index} of ${turn.count}: ${playerName(turn.player)} (${turn.player.rating})`;
      }
      services.Item.clearTransferMarketCache();
      const response = await call(services.Item.searchTransferMarket(criteria, 1));
      run.searches++;
      if (!response.success) return stop(failure("Search", response));
      const items = (response.data && response.data.items) || [];
      const listings = items.filter((item) => inRange(item, criteria.maxBuy));
      run.found += listings.length;
      let step = listings.length ? `${listings.length} found` : "Nothing found";
      // By player: a player with no listing in this search is searched once more without any limit (the same
      // check as the Search button); with no listing at all he is saved as not on market and skipped from now on.
      if (turn && !items.length) {
        await sleep(PLAYER_PAUSE_MS);
        if (!run.active) break;
        const any = await anyListing(turn.player);
        run.searches++;
        if (any.error) return stop(any.error);
        if (!any.count) {
          markOffMarket(turn.player);
          run.offMarket++;
          step += ", saved as not on market";
        }
      }
      run.message = byPlayerOn() && run.message.startsWith("Player ") ? `${run.message.split(" · ")[0]} · ${step}` : step;
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
    Object.assign(run, { active: true, endsAt: Date.now() + settings.runSeconds * 1000, searches: 0, found: 0, bought: 0, listed: 0, moved: 0, spent: 0, offMarket: 0, message: "Starting...", lastBuy: "" });
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

  // Empty means no limit (stored as 0).
  function ratingField(label, key) {
    const wrap = el("label", "fc27-sniper-field fc27-rating-field");
    const input = el("input");
    input.type = "number";
    input.min = "40";
    input.max = "99";
    input.placeholder = "Any";
    input.value = settings[key] ? String(settings[key]) : "";
    input.addEventListener("change", () => {
      const value = Math.round(Number(input.value));
      settings[key] = input.value === "" || !Number.isFinite(value) ? 0 : Math.min(99, Math.max(40, value));
      input.value = settings[key] ? String(settings[key]) : "";
      for (const other of document.querySelectorAll(`.fc27-rating-field input[data-key="${key}"]`)) if (other !== input) other.value = input.value;
      applyRating();
    });
    input.dataset.key = key;
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
    const rating = el("div", "fc27-sniper-row fc27-rating-row");
    const on = checkField("On", "ratingOn");
    on.title = "Use the Rating filter for searches, the sniper and Find cheapest.";
    on.querySelector("input").addEventListener("change", () => {
      for (const other of document.querySelectorAll(".fc27-rating-on input")) other.checked = settings.ratingOn;
      applyRating();
      render();
    });
    on.classList.add("fc27-rating-on");
    const byPlayer = checkField("By player", "byPlayer");
    byPlayer.title = "Search the players whose card has a rating in the range, one player per search, in turn.";
    const find = el("button", "btn-standard fc27-sniper-find", "Find cheapest");
    find.type = "button";
    find.title = "Look for the lowest Buy Now in the Rating range (up to 8 market searches).";
    find.addEventListener("click", () => !run.active && !finding && findCheapest());
    rating.append(el("span", "fc27-sniper-title", "Rating"), on, ratingField("Min", "ratingMin"), ratingField("Max", "ratingMax"), byPlayer, find);
    const row = el("div", "fc27-sniper-row");
    row.append(
      el("span", "fc27-sniper-title", "Sniper"),
      numberField("Run (s)", "runSeconds", 10, 3600),
      numberField("Wait (s)", "waitSeconds", 1, 60),
      checkField("Buy last found", "buy"),
      selectField("After buy", "afterBuy", AFTER_BUY),
      button
    );
    panel.append(rating, row, el("div", "fc27-sniper-status"));
  }

  function render() {
    for (const panel of document.querySelectorAll(`.${PANEL_CLASS}`)) {
      panel.classList.toggle("is-running", run.active);
      panel.querySelector(".fc27-sniper-start").textContent = run.active ? "Stop" : "Start";
      panel.querySelector(".fc27-sniper-start").disabled = finding;
      const find = panel.querySelector(".fc27-sniper-find");
      find.disabled = run.active || finding || !settings.ratingOn;
      find.textContent = finding ? "Searching..." : "Find cheapest";
      for (const input of panel.querySelectorAll("input, select")) input.disabled = run.active || finding;
      // While Rating is off, its fields are greyed out; only the On switch stays usable.
      panel.classList.toggle("fc27-rating-off", !settings.ratingOn);
      for (const input of panel.querySelectorAll(".fc27-rating-field input, .fc27-rating-row .fc27-sniper-check:not(.fc27-rating-on) input")) {
        if (!settings.ratingOn) input.disabled = true;
      }
      const left = Math.max(0, Math.ceil((run.endsAt - Date.now()) / 1000));
      const counts = run.searches
        ? `${run.searches} searches · ${run.found} found · ${run.bought} bought (${fmt(run.spent)})` +
          (run.listed ? ` · ${run.listed} listed` : "") +
          (run.moved ? ` · ${run.moved} to Transfer List` : "") +
          (run.offMarket ? ` · ${run.offMarket} saved as not on market` : "")
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
