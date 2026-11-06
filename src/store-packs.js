// Store > Packs > My Packs: a header above the packs with how many there are and a filter by pack name (with each
// name's count). The filter only hides tiles on screen; the app's own list and buttons are unchanged. It works
// on the page's markup, so it runs in the extension's isolated world.
(() => {
  const BAR_CLASS = "fc27-packs-bar";
  const HIDDEN_CLASS = "fc27-pack-hidden";
  let selected = null; // pack name shown, or null for all

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  // My Packs is the first of the Store hub's tabs.
  function myPacksContent() {
    const hub = [...document.querySelectorAll(".ut-store-hub-view")].find((v) => v.offsetParent);
    const tabs = hub && hub.querySelectorAll(":scope > .ea-filter-bar-view .ea-filter-bar-item-view");
    if (!tabs || !tabs.length || !tabs[0].classList.contains("selected")) return null;
    return hub.querySelector(":scope > .ut-store-hub-view--content");
  }

  const packName = (tile) => (tile.querySelector(".ut-store-pack-details-view--title")?.textContent || "").trim();

  function render() {
    const content = myPacksContent();
    for (const bar of document.querySelectorAll(`.${BAR_CLASS}`)) if (!content || bar.parentElement !== content) bar.remove();
    if (!content) return;
    const tiles = [...content.querySelectorAll(":scope > .ut-store-pack-details-view")];
    const counts = new Map();
    for (const tile of tiles) counts.set(packName(tile), (counts.get(packName(tile)) || 0) + 1);
    if (selected && !counts.has(selected)) selected = null;
    for (const tile of tiles) tile.classList.toggle(HIDDEN_CLASS, !!selected && packName(tile) !== selected);

    let bar = content.querySelector(`:scope > .${BAR_CLASS}`);
    if (!bar) {
      bar = el("div", BAR_CLASS);
      content.insertBefore(bar, tiles[0] || null);
    }
    const shown = selected ? counts.get(selected) : tiles.length;
    const summary = el("div", "fc27-packs-summary");
    summary.append(el("span", "fc27-packs-count", String(shown)), el("span", "fc27-packs-label", shown === 1 ? "pack" : "packs"));
    if (selected) summary.append(el("span", "fc27-packs-of", `of ${tiles.length}`));

    const chips = el("div", "fc27-packs-chips");
    const chip = (label, count, value) => {
      const button = el("button", "fc27-packs-chip");
      button.type = "button";
      button.setAttribute("aria-pressed", String(selected === value));
      button.append(el("span", null, label), el("span", "fc27-packs-chip-count", String(count)));
      button.addEventListener("click", () => {
        selected = value;
        render();
      });
      return button;
    };
    chips.append(chip("All", tiles.length, null));
    for (const [name, count] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) chips.append(chip(name, count, name));
    bar.replaceChildren(summary, chips);
  }

  // The app redraws the list when packs load, open or the tab changes; the header follows it.
  let pending = false;
  new MutationObserver((records) => {
    if (pending || records.every((r) => r.target.closest && r.target.closest(`.${BAR_CLASS}`))) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      render();
    });
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
})();
