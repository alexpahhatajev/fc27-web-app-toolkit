// Club > Players only: the Left and Right arrow keys turn the pages, and in grid mode (html.fc27-grid, set by
// wide-mode.js) a page holds 90 players instead of 20. Runs in the page world to reach the app's classes.
// Club > Players is UTClubSearchResultsViewController with a player search; the squad and SBC club searches
// use UTSelectItemFromClubViewController with the same list view and stay as the app made them. Its list is
// marked with `fc27-club-players`, which content.css and the arrow keys look for.
// The app already loads 91 club items per request (MAX_ITEMS_REQUEST + 1) and splits them into pages of
// `itemsPerPage.club`, read when the list opens, so the larger page sends no extra requests.
(() => {
  const GRID_PAGE_SIZE = 90;
  const LIST_CLASS = "fc27-club-players";
  let openingClubPlayers = false;

  const isPlayerSearch = (criteria) => criteria && criteria.type === SearchType.PLAYER;

  const ready = setInterval(() => {
    if (typeof EAConfigurationRepository !== "function" || typeof UTClubSearchResultsViewController !== "function") return;
    clearInterval(ready);
    const controller = UTClubSearchResultsViewController.prototype;

    // The page size is read while the list's view model is created, in initWithSearchCriteria.
    const initWithSearchCriteria = controller.initWithSearchCriteria;
    controller.initWithSearchCriteria = function (criteria) {
      openingClubPlayers = isPlayerSearch(criteria);
      try {
        return initWithSearchCriteria.apply(this, arguments);
      } finally {
        openingClubPlayers = false;
      }
    };

    const viewDidAppear = controller.viewDidAppear;
    controller.viewDidAppear = function () {
      const result = viewDidAppear.apply(this, arguments);
      try {
        this.getView().getRootElement().classList.toggle(LIST_CLASS, isPlayerSearch(this.searchCriteria));
      } catch (e) {
        // Leave the list unmarked if the app changed its structure.
      }
      return result;
    };

    // The app reloads its config, so the page size is applied when the config is read rather than written once.
    const config = EAConfigurationRepository.prototype;
    const getConfigObject = config.getConfigObject;
    config.getConfigObject = function (key) {
      const value = getConfigObject.apply(this, arguments);
      if (key !== EAConfigurationRepository.KEY_ITEMS_PER_PAGE || !value || !openingClubPlayers) return value;
      if (!document.documentElement.classList.contains("fc27-grid")) return value;
      return { ...value, [EAConfigurationRepository.ITEMS_PER_PAGE.CLUB]: GRID_PAGE_SIZE };
    };
  }, 200);

  // The app's buttons react to a mouse press and release, not to a plain click().
  function press(button) {
    const r = button.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    button.dispatchEvent(new MouseEvent("mousedown", init));
    button.dispatchEvent(new MouseEvent("mouseup", init));
  }

  // A long page scrolls inside the list and the app keeps that scroll position; a new page starts at the top.
  document.addEventListener(
    "mouseup",
    (event) => {
      const button = event.target.closest && event.target.closest(`.${LIST_CLASS} .pagination`);
      if (!button) return;
      const list = button.closest(`.${LIST_CLASS}`).querySelector("ul.paginated");
      setTimeout(() => list && (list.scrollTop = 0), 0);
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || document.getElementById("fc27-shortcuts")) return;
      const target = event.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const list = [...document.querySelectorAll(`.${LIST_CLASS}`)].find((v) => v.offsetParent);
      const button = list && list.querySelector(`.pagination.${event.key === "ArrowLeft" ? "prev" : "next"}`);
      if (!button || !button.offsetParent || button.disabled) return;
      event.preventDefault();
      press(button);
    },
    true
  );
})();
