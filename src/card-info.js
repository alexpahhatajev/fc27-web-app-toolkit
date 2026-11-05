// Shows alternative positions, skill moves and weak foot on the right side of every player card,
// and the league above it.
// Runs in the page world and hooks renderItem of UTPlayerItemView and of every subclass that overrides it
// (small, large and squad cards); decorate() replaces its own overlay, so a double call is harmless.
(() => {
  const INFO_CLASS = "fc27-card-info";
  const LEAGUE_CLASS = "fc27-card-league";

  const rgb = (c) => (c ? `rgb(${c.r}, ${c.g}, ${c.b})` : null);

  // Boxes use the card's own colors from the app's rarity color map: `background` is the card fill,
  // `header` the color of its rating and position.
  function applyCardColors(root, info, colorSource) {
    let map = null;
    try {
      const tier = colorSource.item.getTier();
      map = root.classList.contains("large") ? colorSource.ctx.getLargeColorMap(tier) : colorSource.ctx.getSmallColorMap(tier);
    } catch (e) {
      // No color map: the CSS fallback colors stay.
    }
    if (!map) return;
    info.style.setProperty("--fc27-card-bg", rgb(map.background));
    info.style.setProperty("--fc27-card-fg", rgb(map.header));
  }

  function box(text) {
    const el = document.createElement("span");
    el.textContent = text;
    return el;
  }

  // shownPosition is the position the card displays: in a squad slot the player can play, that is the slot's
  // position (set by renderPosition); otherwise the player's main position. It is left out of the boxes.
  function decorate(root, item, ctx, shownPosition) {
    if (!root) return;
    root.querySelectorAll(`:scope > .${INFO_CLASS}, :scope > .${LEAGUE_CLASS}`).forEach((el) => el.remove());
    // Empty squad slots get a placeholder item that the app itself treats as not valid.
    if (!item || typeof item.getSkillMoves !== "function" || (typeof item.isValid === "function" && !item.isValid())) return;

    const shown = shownPosition != null ? shownPosition : item.preferredPosition;
    const positions = (item.possiblePositions || []).filter((id) => id !== shown);
    const info = document.createElement("div");
    info.className = INFO_CLASS;
    info.append(
      ...positions.map((id) => box(UTLocalizationUtil.positionIdToName(id, services.Localization, item.gender))),
      box(`${item.getSkillMoves()}\u2605 ${item.getWeakFoot()}W`)
    );
    applyCardColors(root, info, { item, ctx });
    root.append(info);

    if (item.leagueId) {
      const league = document.createElement("div");
      league.className = LEAGUE_CLASS;
      // Women's leagues share the men's abbreviations ("ENG 1"); the app marks women's players with gender 1.
      const abbr = UTLocalizationUtil.leagueIdToAbbr5(item.leagueId, services.Localization);
      league.textContent = item.gender === 1 ? `W ${abbr}` : abbr;
      root.append(league);
    }
  }

  // The position a view last displayed, kept per item so a reused view never applies another player's slot.
  const shownFor = (view, item) => (view.__fc27Shown && view.__fc27Shown.id === item.id ? view.__fc27Shown.position : null);

  function hookClass(cls) {
    const proto = cls.prototype;
    const original = proto.renderItem;
    proto.renderItem = function (item) {
      const result = original.apply(this, arguments);
      try {
        this.__fc27Ctx = arguments[1];
        decorate(this.getRootElement(), item, this.__fc27Ctx, item ? shownFor(this, item) : null);
      } catch (e) {
        // Never break the app's own card rendering.
      }
      return result;
    };
  }

  // Same rule as the app's renderPosition(item, slot): the slot's position when the player can play it.
  function hookRenderPosition() {
    const proto = UTPlayerItemView.prototype;
    const original = proto.renderPosition;
    if (typeof original !== "function") return;
    proto.renderPosition = function (item, slot) {
      const result = original.apply(this, arguments);
      try {
        const position = slot && slot.inPossiblePosition ? slot.generalPosition : item.preferredPosition;
        this.__fc27Shown = { id: item.id, position };
        const root = this.getRootElement();
        if (root && root.querySelector(`:scope > .${INFO_CLASS}`)) decorate(root, item, this.__fc27Ctx, position);
      } catch (e) {
        // Never break the app's own card rendering.
      }
      return result;
    };
  }

  function hook() {
    const classes = Object.keys(window)
      .filter((name) => /^UT\w*PlayerItemView$/.test(name))
      .map((name) => window[name])
      .filter((cls) => typeof cls === "function" && (cls === UTPlayerItemView || cls.prototype instanceof UTPlayerItemView))
      .filter((cls) => Object.prototype.hasOwnProperty.call(cls.prototype, "renderItem"));
    classes.forEach(hookClass);
    hookRenderPosition();
  }

  // The app defines its view classes after the page loads.
  const ready = setInterval(() => {
    if (window.UTPlayerItemView && window.UTLocalizationUtil && window.services) {
      clearInterval(ready);
      hook();
    }
  }, 200);
})();
