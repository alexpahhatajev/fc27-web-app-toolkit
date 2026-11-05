// Adds "Grid" and "Wide" toggles to the header. Grid shows the club's player list as a grid of cards
// (content.css). Wide lifts the app's page width caps, and squad cards grow to the largest size at which
// no two cards touch (fitSquadCards). Each choice is kept in chrome.storage.local.
(() => {
  const TOGGLES = [
    {
      id: "fc27-grid-toggle",
      key: "gridMode",
      className: "fc27-grid",
      label: "Grid",
      on: "Grid mode on. Click to list club players in rows.",
      off: "Grid mode off. Click to show club players as a grid of cards.",
    },
    {
      id: "fc27-wide-toggle",
      key: "wideMode",
      className: "fc27-wide",
      label: "Wide",
      on: "Wide mode on. Click for the standard layout.",
      off: "Wide mode off. Click to use the full window width.",
    },
  ];
  const CURRENCY_SELECTOR = ".view-navbar-currency";
  const PITCH_SELECTOR = ".ut-squad-pitch-view";
  const MAX_SCALE = 1.6;
  // Gap kept between cards, the drawn card's distance below the top of its element (the league box sits
  // there), and how far the slanted background of the formation/chemistry bar reaches past the element.
  const GAP = 0.97;
  const CARD_TOP_INSET = 0.12;
  const SUMMARY_SLANT_PX = 40;
  const state = { gridMode: false, wideMode: false };

  // Visible outline of a squad slot around its center, at scale 1: the drawn card plus the chip, the
  // chemistry icon and our boxes. The app's full-size text layer and canvas are not visible area.
  function outline(slot, pitchBox, currentScale) {
    const r = slot.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const card = slot.querySelector(":scope > .player.item");
    let top = r.top + CARD_TOP_INSET * r.height;
    let bottom = r.bottom;
    let left = r.left;
    let right = r.right;
    for (const el of slot.querySelectorAll("*")) {
      if (el === card || el.tagName === "CANVAS" || el.classList.contains("ut-item-view")) continue;
      const e = el.getBoundingClientRect();
      if (!e.width || !e.height) continue;
      top = Math.min(top, e.top);
      bottom = Math.max(bottom, e.bottom);
      left = Math.min(left, e.left);
      right = Math.max(right, e.right);
    }
    return {
      x: cx - pitchBox.left,
      y: cy - pitchBox.top,
      up: (cy - top) / currentScale,
      cardUp: (cy - (r.top + CARD_TOP_INSET * r.height)) / currentScale,
      down: (bottom - cy) / currentScale,
      left: (cx - left) / currentScale,
      right: (right - cx) / currentScale,
    };
  }

  // Cards are placed by their centers, so scaling each slot around its center keeps the formation.
  // Two cards touch at the scale where their outlines meet horizontally or vertically; the pitch edges
  // and the formation/chemistry bar at the top limit it too.
  function fitSquadCards() {
    const pitch = document.querySelector(PITCH_SELECTOR);
    // A dragged slot is unscaled for the moment (content.css) and would measure too small.
    if (!pitch || pitch.querySelector(".drag-in-progress, .isDragging")) return;
    if (!observedPitches.has(pitch)) {
      observedPitches.add(pitch);
      pitchResize.observe(pitch);
    }
    const box = pitch.getBoundingClientRect();
    if (!box.width) return;
    const currentScale = parseFloat(pitch.style.getPropertyValue("--fc27-slot-scale")) || 1;
    // Player cards decide the size; the manager card in the corner grows into the pitch (content.css).
    const cards = [...pitch.querySelectorAll(".ut-squad-slot-view")]
      .filter((slot) => slot.offsetWidth && slot.querySelector(":scope > .player.item"))
      .map((slot) => outline(slot, box, currentScale));
    if (!cards.length) return;

    const summary = document.querySelector(".ut-squad-overview .ut-squad-summary");
    const bar = summary && summary.getBoundingClientRect();

    let scale = MAX_SCALE;
    for (const c of cards) {
      scale = Math.min(scale, c.x / c.left, (box.width - c.x) / c.right, c.y / c.up, (box.height - c.y) / c.down);
      if (bar && bar.height) {
        const barLeft = bar.left - box.left - SUMMARY_SLANT_PX;
        const barRight = bar.right - box.left + SUMMARY_SLANT_PX;
        const barBottom = bar.bottom - box.top;
        const reachesBar = c.x + MAX_SCALE * c.right > barLeft && c.x - MAX_SCALE * c.left < barRight;
        // The drawn card stays below the bar; a top-row card's small league box may tuck under it.
        if (reachesBar && c.y > barBottom) scale = Math.min(scale, ((c.y - barBottom) / c.cardUp) * GAP);
      }
    }
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const [l, r] = cards[i].x <= cards[j].x ? [cards[i], cards[j]] : [cards[j], cards[i]];
        const [u, d] = cards[i].y <= cards[j].y ? [cards[i], cards[j]] : [cards[j], cards[i]];
        scale = Math.min(scale, Math.max((r.x - l.x) / (l.right + r.left), (d.y - u.y) / (u.down + d.up)) * GAP);
      }
    }
    pitch.style.setProperty("--fc27-slot-scale", Math.max(1, scale).toFixed(3));
  }

  // The pitch also changes size without a window resize (panels opening, layout changes).
  const observedPitches = new WeakSet();
  const pitchResize = new ResizeObserver(() => scheduleFit());

  let fitPending = false;
  function scheduleFit() {
    if (fitPending) return;
    fitPending = true;
    requestAnimationFrame(() => {
      fitPending = false;
      if (state.wideMode) fitSquadCards();
    });
  }

  function apply() {
    for (const t of TOGGLES) {
      document.documentElement.classList.toggle(t.className, state[t.key]);
      const toggle = document.getElementById(t.id);
      if (toggle) {
        toggle.setAttribute("aria-pressed", String(state[t.key]));
        toggle.title = state[t.key] ? t.on : t.off;
      }
    }
    scheduleFit();
  }

  // The navbar is re-rendered on navigation, so the toggles are put back before the currency row, in order.
  function ensureToggles() {
    const currency = document.querySelector(CURRENCY_SELECTOR);
    if (!currency || TOGGLES.every((t) => document.getElementById(t.id))) return;
    for (const t of TOGGLES) {
      if (document.getElementById(t.id)) continue;
      const toggle = document.createElement("button");
      toggle.id = t.id;
      toggle.type = "button";
      toggle.className = "fc27-toggle";
      toggle.textContent = t.label;
      toggle.addEventListener("click", () => {
        state[t.key] = !state[t.key];
        apply();
        chrome.storage.local.set({ [t.key]: state[t.key] });
      });
      currency.parentElement.insertBefore(toggle, currency);
    }
    apply();
  }

  // In wide mode the market search tabs show only icons (content.css); their own text becomes the hover title.
  function labelMarketTabs() {
    for (const tab of document.querySelectorAll(".ut-market-search-filters-view .ea-filter-bar-item-view:not([title])")) {
      tab.title = tab.textContent.trim();
    }
  }

  // The search form scrolls inside its own list; the category buttons above its first row follow it (content.css).
  document.addEventListener(
    "scroll",
    (event) => {
      const list = event.target;
      if (!(list instanceof Element) || !list.matches(".ut-market-search-filters-view .ut-pinned-list")) return;
      list.closest(".ut-market-search-filters-view").style.setProperty("--fc27-form-scroll", String(list.scrollTop));
    },
    true
  );

  chrome.storage.local.get(TOGGLES.map((t) => t.key)).then((stored) => {
    for (const t of TOGGLES) state[t.key] = stored[t.key] === true;
    apply();
  });

  // Navigation, formation changes and moved players all re-render nodes; the class covers the formation itself.
  new MutationObserver(() => {
    ensureToggles();
    labelMarketTabs();
    scheduleFit();
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  window.addEventListener("resize", scheduleFit);
  ensureToggles();
})();
