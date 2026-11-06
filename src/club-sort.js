// "Sort by BIN" in the header of Club > Players (the list club-list.js marks with fc27-club-players): checks the
// lowest Buy Now price of every tradeable player with the Lowest BIN check (price-check.js), one player after
// another with a pause, then shows the club list with the most valuable tradeable players first. Untradeable
// players and players without a price follow in the app's own order. Each checked card shows its price.
// When a player leaves the sorted list (listed, sent to the squad, quick sold), the app rebuilds the list in its
// own order; the BIN order is put back at once, on the same page.
// Runs in the page world. A click while checking stops it; EA refusing a search stops it too.
(() => {
  const BUTTON_CLASS = "fc27-club-sort";
  const LABEL_CLASS = "fc27-club-bin";
  const PAUSE_MS = 2000;
  const prices = new Map(); // definitionId -> lowest Buy Now
  let controller = null;
  let sortedModel = null; // the club list view model that holds the BIN order
  let checking = false;
  let stopRequested = false;
  let progress = "";

  const fmt = (n) => n.toLocaleString("en-US");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const ready = setInterval(() => {
    if (typeof UTClubSearchResultsViewController !== "function" || typeof UTItemTableCellView !== "function") return;
    clearInterval(ready);

    const viewDidAppear = UTClubSearchResultsViewController.prototype.viewDidAppear;
    UTClubSearchResultsViewController.prototype.viewDidAppear = function () {
      const result = viewDidAppear.apply(this, arguments);
      if (this.searchCriteria && this.searchCriteria.type === SearchType.PLAYER) controller = this;
      return result;
    };

    // removeItemsById is how the app takes a player out of the list; it re-sorts the rest by its own order.
    let owner = UTClubViewModel.prototype;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, "removeItemsById")) owner = Object.getPrototypeOf(owner);
    if (owner) {
      const removeItemsById = owner.removeItemsById;
      owner.removeItemsById = function () {
        const result = removeItemsById.apply(this, arguments);
        if (this === sortedModel) {
          try {
            keepOrder(this);
          } catch (e) {
            // Leave the app's order if its structure changed.
          }
        }
        return result;
      };
    }

    // The price label is added to every row of a checked card; content.css shows it only in Club > Players.
    const render = UTItemTableCellView.prototype.render;
    UTItemTableCellView.prototype.render = function () {
      const result = render.apply(this, arguments);
      try {
        const root = this.getRootElement();
        const item = this.getData();
        const price = item && item.tradable ? prices.get(item.definitionId) : null;
        let label = root.querySelector(`.${LABEL_CLASS}`);
        if (!price) {
          if (label) label.remove();
        } else {
          if (!label) {
            label = document.createElement("span");
            label.className = LABEL_CLASS;
            (root.querySelector(".rowContent") || root).append(label);
          }
          label.textContent = fmt(price);
          label.title = `Lowest Buy Now ${fmt(price)}`;
        }
      } catch (e) {
        // Leave the row as the app drew it.
      }
      return result;
    };
  }, 200);

  function setProgress(text) {
    progress = text;
    for (const button of document.querySelectorAll(`.${BUTTON_CLASS}`)) {
      button.textContent = checking ? `Stop (${text})` : "Sort by BIN";
      button.title = checking ? "Checking lowest Buy Now prices; click to stop." : text || "Check the lowest Buy Now of every tradeable player and sort by it.";
    }
  }

  // The list loads the club in batches of 90. The club service answers with every player loaded so far, so
  // the next batch is asked for until it reports retrievedAll; these are club requests, not market searches.
  async function allPlayers() {
    const search = (offset) =>
      new Promise((resolve) => {
        const criteria = new UTSearchCriteriaDTO();
        criteria.update(controller.searchCriteria);
        criteria.offset = offset;
        const scope = {};
        services.Club.search(criteria).observe(scope, (observable, response) => {
          observable.unobserve(scope);
          resolve(response.success ? response.response || response.data : null);
        });
      });
    let body = null;
    for (let offset = 0; offset <= 900; offset += 90) {
      body = await search(offset);
      if (!body || body.retrievedAll || body.items.length < offset + 91) break;
    }
    return body ? body.items : controller.clubViewModel.values().slice();
  }

  // Tradeable players first by price, highest first; the rest keep the order the app gave them.
  function byPrice(items) {
    const priced = items.filter((i) => i.tradable && prices.has(i.definitionId));
    priced.sort((a, b) => prices.get(b.definitionId) - prices.get(a.definitionId));
    return [...priced, ...items.filter((i) => !priced.includes(i))];
  }

  function applySort(items) {
    const model = controller && controller.clubViewModel;
    if (!model) return;
    model.resetCollection(byPrice(items));
    // The list holds every club player, so the app must not load more and re-sort when the page changes.
    model.isFull = true;
    model.setIndex(0);
    sortedModel = model;
    controller.refreshList();
  }

  // After a removal: the remaining players in BIN order again, on the page that was open.
  function keepOrder(model) {
    const index = model.getIndex();
    model.resetCollection(byPrice(model.values().slice()));
    model.isFull = true;
    model.setIndex(Math.min(index, Math.max(0, model.length - 1)));
    if (controller && controller.clubViewModel === model) controller.refreshList();
  }

  async function checkAll() {
    const model = controller && controller.clubViewModel;
    if (!model || typeof window.fc27FindLowest !== "function") return setProgress("Open Club > Players first.");
    checking = true;
    setProgress("loading club");
    const club = await allPlayers();
    const seen = new Set();
    const players = club.filter((i) => i.tradable && !seen.has(i.definitionId) && seen.add(i.definitionId));
    stopRequested = false;
    let failed = "";
    for (let n = 0; n < players.length && !stopRequested; n++) {
      setProgress(`${n + 1}/${players.length}`);
      if (n > 0) await sleep(PAUSE_MS);
      const result = await window.fc27FindLowest(players[n], () => {});
      if (result.lowest) prices.set(players[n].definitionId, result.lowest);
      if (result.error) {
        failed = result.error;
        break;
      }
    }
    checking = false;
    applySort(club);
    const done = players.filter((p) => prices.has(p.definitionId)).length;
    setProgress(failed ? `Stopped: ${failed}. ${done} priced.` : `${done} of ${players.length} tradeable players priced.`);
  }

  function ensureButton() {
    for (const list of document.querySelectorAll(".fc27-club-players")) {
      const actions = list.querySelector(".ut-list-header-action");
      if (!actions || actions.querySelector(`.${BUTTON_CLASS}`)) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `btn-standard mini ${BUTTON_CLASS}`;
      button.addEventListener("click", () => {
        if (checking) stopRequested = true;
        else checkAll();
      });
      actions.prepend(button);
      setProgress(progress);
    }
  }

  new MutationObserver(ensureButton).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
})();
