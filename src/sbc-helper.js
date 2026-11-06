// One-click score SBCs (Gold Re-Roll and any other): an "Auto fill" panel under the challenge requirements. Runs
// in the page world.
// The price table has a row per gold rating up to the challenge's OVR max, plus Bronze and Silver. Each row's score
// is EA's own (sbsScore of regular cards in the club or on the market); "Check prices" finds the cheapest Buy Now
// for the few ratings that look best value by EA's market averages and keeps them 30 minutes. A row with a max
// price and a tick can be bought.
// Plan covers the score still needed with allowed fodder first (untradeable players rated at most the OVR max,
// not in the active squad, not locked for SBC (player-lock.js), not loans, not special unless allowed), then the
// cheapest mix of bought cards at their max prices plus a cost per extra card (fewer market requests).
// Buy & submit works in batches of at most the free Unassigned places (EA allows 5): buy, submit (EA keeps a
// partial score), plan again, until the challenge completes. Bought players are submitted from Unassigned (a
// bought duplicate fits neither the club nor SBC Storage); players bought in a run that stopped are used first next
// time. The reward pack stays in My Packs. It stops on the first EA refusal and says where it stopped.
(() => {
  const PANEL_CLASS = "fc27-sbc-helper";
  // Pauses between market searches and between buys, kept slow so repeated rounds stay under EA's limits.
  const PAUSE_MS = 2500;
  const BUY_PAUSE_MS = 1500;
  const SEARCHES_PER_BUY = 6;
  const BATCHES = 12;
  const UNASSIGNED_LIMIT = 5;
  const CARDS_PER_SUBMIT = 30;
  // After EA answers "too many requests" (status 521, or 429), buying and price checks wait COOLDOWN_MIN minutes;
  // rounds that need no buying still run. The end time is kept in this browser (localStorage).
  const SLOW_DOWN = [429, 521];
  const COOLDOWN_MIN = 60;
  const COOLDOWN_KEY = "fc27-market-cooldown";
  const PRICES_KEY = "fc27-sbc-prices";
  const LEFTOVERS_KEY = "fc27-sbc-leftovers";
  const PRICES_MS = 30 * 60 * 1000;
  const CHECK_RATINGS = 4;
  // Scores of regular gold cards seen so far; the club and market listings replace or add to them.
  const KNOWN_SCORES = { 76: 100, 77: 120, 78: 140, 79: 160, 80: 180, 81: 280, 82: 340, 83: 410, 84: 830, 85: 2100, 86: 4100, 88: 8300 };

  const settings = { useFodder: true, allowSpecial: false, budget: 0, perBuy: 100 };
  const state = { busy: false, plan: null, message: "", spent: 0 };
  const scores = { ...KNOWN_SCORES, bronze: 20, silver: 35 }; // tier key -> score
  const estimates = {}; // tier key -> lowest EA market average among regular cards of that rating
  const caps = {}; // tier key -> max price set by the user
  const unticked = new Set(); // tier keys the user turned off
  const leftovers = new Set(); // ids of players this panel bought that still wait in Unassigned (kept in localStorage)
  // EA cannot search by rating, so a search shows a tier's listings only by chance among the cheap cards of all
  // ratings. What the searches saw is kept for buying: the listings (until they end) and the players.
  const seen = {}; // tier key -> Map(trade id -> { item, price, until })
  const seenPlayers = {}; // tier key -> Set of player definition ids

  const fmt = (n) => n.toLocaleString("en-US");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const call = (observable) =>
    new Promise((resolve) => {
      const scope = {};
      const timer = setTimeout(() => resolve({ success: false, status: 0 }), 20000);
      observable.observe(scope, (o, response) => {
        o.unobserve(scope);
        clearTimeout(timer);
        resolve(response);
      });
    });
  const failure = (what, r) => `${what} failed (status ${r.status || "none"}${r.error && r.error.code ? ", code " + r.error.code : ""})`;
  const name = (item) => (item._staticData && item._staticData.name) || String(item.definitionId);
  const below = (price) => UTCurrencyInputControl.getIncrementBelowVal(price);
  const above = (price) => UTCurrencyInputControl.getIncrementAboveVal(price);

  const storage = {
    get(key) {
      try {
        return JSON.parse(localStorage.getItem(key) || "null");
      } catch (e) {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        // Without storage the values last until the page reloads.
      }
    },
  };
  for (const id of storage.get(LEFTOVERS_KEY) || []) leftovers.add(id);
  const saveLeftovers = () => storage.set(LEFTOVERS_KEY, [...leftovers]);
  const cooldownUntil = () => Number(storage.get(COOLDOWN_KEY)) || 0;
  const coolingDown = () => cooldownUntil() > Date.now();
  const untilText = () => new Date(cooldownUntil()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const startCooldown = () => storage.set(COOLDOWN_KEY, Date.now() + COOLDOWN_MIN * 60 * 1000);

  // Checked prices younger than PRICES_MS: tier key -> { price, at }.
  function checkedPrices() {
    const all = storage.get(PRICES_KEY) || {};
    return Object.fromEntries(Object.entries(all).filter(([, v]) => Date.now() - v.at < PRICES_MS));
  }

  // The open one-click challenge and its set, from the app's work area controller.
  function openChallenge() {
    const seen = new Set();
    let found = null;
    const visit = (x, depth) => {
      if (!x || found || seen.has(x) || depth > 14) return;
      seen.add(x);
      if (x.className === "UTOneClickSBCWorkAreaViewController" || x.className === "UTOneClickSBCReviewViewController") {
        const vm = x.viewModel;
        if (vm && vm._challenge) found = { challenge: vm._challenge, set: vm._set };
      }
      for (const key of Object.keys(x)) {
        const v = x[key];
        if (Array.isArray(v)) v.forEach((y) => y && typeof y === "object" && y.className && visit(y, depth + 1));
        else if (v && typeof v === "object" && v.className) visit(v, depth + 1);
      }
    };
    visit(getAppMain().getRootViewController(), 0);
    return found;
  }

  // The challenge as EA has it now (status and submitted score change with every submit).
  async function freshChallenge() {
    const open = openChallenge();
    if (!open) throw new Error("Open a one-click score SBC first.");
    const loaded = await call(services.SBC.requestChallengesForSet(open.set));
    const challenge = ((loaded.data && loaded.data.challenges) || []).find((c) => c.id === open.challenge.id) || open.challenge;
    return { challenge, set: open.set };
  }

  // "OVR Max: 83" as the app shows it in the challenge requirements; no such line means no limit.
  function maxOvr() {
    const text = document.querySelector(".ut-sbc-challenge-requirements-view")?.innerText || "";
    const match = /OVR[^\n]*?Max[^\d]*(\d+)|Max[^\n]*?OVR[^\d]*(\d+)/i.exec(text);
    return match ? Number(match[1] || match[2]) : 99;
  }

  // Rows of the price table: gold ratings 75 up to the OVR max (at most 91) with a known score, then Silver, Bronze.
  function tiers(limit) {
    const rows = [];
    for (let rating = Math.min(limit, 91); rating >= 75; rating--) {
      if (scores[rating]) rows.push({ key: String(rating), label: String(rating), level: "gold", rating, score: scores[rating] });
    }
    rows.push({ key: "silver", label: "Silver", level: "silver", rating: null, score: scores.silver });
    rows.push({ key: "bronze", label: "Bronze", level: "bronze", rating: null, score: scores.bronze });
    const prices = checkedPrices();
    for (const t of rows) {
      t.price = prices[t.key] ? prices[t.key].price : null;
      t.cap = caps[t.key] != null ? caps[t.key] : t.price ? above(t.price) : 0;
      t.use = !unticked.has(t.key) && t.cap > 0;
    }
    return rows;
  }

  async function clubPlayers() {
    const page = (offset) => call(services.Club.search(Object.assign(new UTSearchCriteriaDTO(), { type: SearchType.PLAYER, count: 91, offset })));
    let body = null;
    for (let offset = 0; offset <= 900; offset += 90) {
      const r = await page(offset);
      body = r.success ? r.response || r.data : null;
      if (!body || body.retrievedAll || body.items.length < offset + 91) break;
    }
    return body ? body.items : [];
  }

  async function storagePlayers() {
    try {
      const r = await call(services.Item.searchStorageItems(Object.assign(new UTSearchCriteriaDTO(), { type: SearchType.PLAYER, count: 100 })));
      const body = r.success ? r.response || r.data : null;
      return (body && body.items) || [];
    } catch (e) {
      return [];
    }
  }

  function activeSquadIds() {
    try {
      const outer = repositories.Squad.squads._collection;
      const inner = outer[Object.keys(outer)[0]];
      const squads = inner._collection || inner;
      const id = services.Squad.getActiveSquadId();
      const squad = squads[id] || Object.values(squads).find((s) => s.id === id);
      return new Set(squad.getPlayers().map((slot) => slot.getItem && slot.getItem()).filter(Boolean).map((i) => i.id));
    } catch (e) {
      return new Set();
    }
  }

  const isSpecial = (i) => typeof i.isSpecial === "function" && i.isSpecial();

  // Scores and market averages of regular gold cards, learned from cards EA sent (club or market).
  function learn(items) {
    const averages = {};
    for (const i of items) {
      if (isSpecial(i) || !(i.sbsScore > 0) || i.rating < 75) continue;
      scores[i.rating] = i.sbsScore;
      if (i._marketAverage > 0) (averages[i.rating] = averages[i.rating] || []).push(i._marketAverage);
    }
    // The lowest average: one sought-after player (a high average) says little about the cheapest card.
    for (const [rating, list] of Object.entries(averages)) estimates[rating] = Math.min(estimates[rating] || Infinity, ...list);
  }

  async function fodderPool(items, limit) {
    if (!settings.useFodder) return [];
    const squad = activeSquadIds();
    const seen = new Set();
    return items.filter((i) => {
      if (seen.has(i.id)) return false;
      seen.add(i.id);
      return (
        !i.tradable &&
        i.sbsScore > 0 &&
        i.rating <= limit &&
        !squad.has(i.id) &&
        !leftovers.has(i.id) &&
        !(window.fc27IsLocked && window.fc27IsLocked(i.id)) &&
        !(i.loans > 0) &&
        !(typeof i.isLimitedUse === "function" && i.isLimitedUse()) &&
        !(typeof i.isActiveInTimedEvolution === "function" && i.isActiveInTimedEvolution()) &&
        (settings.allowSpecial || !isSpecial(i))
      );
    });
  }

  // Fodder sums reachable without going past `top` (0/1 knapsack, parent pointers for the items used).
  function fodderSums(pool, top) {
    const from = new Int32Array(top + 1).fill(-1);
    const item = new Int32Array(top + 1).fill(-1);
    from[0] = 0;
    for (let k = 0; k < pool.length; k++) {
      const s = pool[k].sbsScore;
      for (let sum = top; sum >= 0; sum--) {
        if (from[sum] < 0) continue;
        const next = Math.min(top, sum + s);
        if (next !== sum && from[next] < 0) {
          from[next] = sum;
          item[next] = k;
        }
      }
    }
    // smallest[need] = the smallest reachable sum of at least `need`.
    const smallest = new Int32Array(top + 2).fill(-1);
    for (let sum = top; sum >= 0; sum--) smallest[sum] = from[sum] >= 0 ? sum : smallest[sum + 1];
    return (need) => {
      const sum = smallest[Math.max(0, need)];
      if (sum < 0) return null;
      const items = [];
      for (let s = sum; s > 0; s = from[s]) items.push(pool[item[s]]);
      return { sum, items };
    };
  }

  // The cheapest buys (unbounded per tier, max price plus the cost per extra card) that, with fodder, reach the
  // target; ties go to less fodder used, then fewer cards.
  function cheapestPlan(target, pool, rows) {
    const usable = rows.filter((t) => t.use);
    const top = target + Math.max(0, ...pool.map((i) => i.sbsScore));
    const fodder = fodderSums(pool, Math.max(top, 1));
    // cost[s]: cheapest way to buy exactly s score (s = target stands for "target or more"); prev and tier
    // remember the step that got there.
    const cost = new Float64Array(target + 1).fill(Infinity);
    const prev = new Int32Array(target + 1).fill(-1);
    const tier = new Int32Array(target + 1).fill(-1);
    cost[0] = 0;
    for (let s = 0; s < target; s++) {
      if (cost[s] === Infinity) continue;
      usable.forEach((t, k) => {
        const next = Math.min(target, s + t.score);
        const c = cost[s] + t.cap + settings.perBuy;
        if (c < cost[next]) {
          cost[next] = c;
          prev[next] = s;
          tier[next] = k;
        }
      });
    }
    let plan = null;
    for (let b = 0; b <= target; b++) {
      if (cost[b] === Infinity) continue;
      const use = fodder(target - b);
      if (!use) continue;
      const counts = new Map();
      for (let s = b; s > 0; s = prev[s]) counts.set(usable[tier[s]], (counts.get(usable[tier[s]]) || 0) + 1);
      const buys = [...counts.values()].reduce((a, c) => a + c, 0);
      const coins = [...counts].reduce((sum, [t, n]) => sum + t.cap * n, 0);
      const better =
        !plan || cost[b] < plan.weight || (cost[b] === plan.weight && (use.sum < plan.fodderScore || (use.sum === plan.fodderScore && buys < plan.buys)));
      if (better) plan = { weight: cost[b], coins, counts, buys, fodder: use.items, fodderScore: use.sum };
    }
    return plan;
  }

  async function unassignedPlayers() {
    repositories.Item.setDirty(ItemPile.PURCHASED);
    const r = await call(services.Item.requestUnassignedItems());
    return ((r.data && r.data.items) || (r.response && r.response.items) || []).filter((i) => i.isPlayer && i.isPlayer());
  }

  async function makePlan() {
    const { challenge, set } = await freshChallenge();
    const target = (challenge.scoreRequirement || 0) - (challenge.submittedScore || 0);
    if (!(target > 0)) throw new Error("This challenge has no score left to submit.");
    const limit = maxOvr();
    setMessage("Reading club and SBC Storage...");
    const unassigned = await unassignedPlayers();
    for (const id of [...leftovers]) if (!unassigned.some((i) => i.id === id)) leftovers.delete(id);
    saveLeftovers();
    // Leftover purchases are already paid for, so they come first.
    const kept = unassigned.filter((i) => leftovers.has(i.id) && i.rating <= limit);
    const keptScore = kept.reduce((sum, i) => sum + i.sbsScore, 0);
    const club = [...(await clubPlayers()), ...(await storagePlayers())];
    learn(club);
    const pool = await fodderPool(club, limit);
    const rows = tiers(limit);
    const plan = cheapestPlan(Math.max(0, target - keptScore), pool, rows);
    if (!plan) {
      const priced = rows.some((t) => t.use);
      throw new Error(priced ? "No mix of fodder and ticked rows reaches the score." : "Check prices first (or set a max price), so there is something to buy.");
    }
    if (settings.budget > 0 && plan.coins > settings.budget) throw new Error(`This needs up to ${fmt(plan.coins)} coins, more than your ${fmt(settings.budget)} per SBC.`);
    if (plan.buys && coolingDown()) throw new Error(`EA asked to slow down; buying is paused until ${untilText()}. This needs ${plan.buys} bought players.`);
    return { ...plan, kept, challenge, set, target, limit, room: UNASSIGNED_LIMIT - unassigned.length };
  }

  function describe(plan) {
    const buys = [...plan.counts].sort((a, b) => b[0].score - a[0].score).map(([t, n]) => `${n}× ${t.label} (max ${fmt(t.cap)})`);
    const fodder = plan.fodder.map((i) => `${name(i)} ${i.rating}`).join(", ");
    const kept = plan.kept.length ? `Already bought: ${plan.kept.map((i) => `${name(i)} ${i.rating}`).join(", ")}. ` : "";
    const batches = plan.buys > Math.max(1, plan.room) ? ` In ${Math.ceil(plan.buys / Math.max(1, plan.room))} batches.` : "";
    return (
      `Need ${fmt(plan.target)} (OVR max ${plan.limit}). ` +
      kept +
      `Fodder ${fmt(plan.fodderScore)}: ${plan.fodder.length ? fodder : "none"}. ` +
      `Buy ${buys.length ? buys.join(", ") : "nothing"} · at most ${fmt(plan.coins)} coins.${batches}`
    );
  }

  // One market search for a tier at or under `maxBuy`; resolves with other sellers' listings of that tier.
  async function searchTier(tier, maxBuy, n, limit, playerId) {
    const criteria = Object.assign(new UTSearchCriteriaDTO(), { type: SearchType.PLAYER, level: tier.level, maxBuy });
    if (playerId) criteria.maskedDefId = playerId;
    // A different Bid Price Min per search makes EA answer each one afresh (as in the sniper).
    criteria.minBid = [0, 150, 200, 250, 300, 350][n % 6];
    services.Item.clearTransferMarketCache();
    const r = await call(services.Item.searchTransferMarket(criteria, 1));
    if (!r.success) throw new Error(failure("Search", r));
    const items = (r.data && r.data.items) || [];
    learn(items);
    const found = items.filter((i) => {
      const a = i.getAuctionData();
      return !a.tradeOwner && a.buyNowPrice > 0 && a.buyNowPrice <= maxBuy && !isSpecial(i) && (tier.rating == null || i.rating === tier.rating) && i.rating <= limit;
    });
    const listings = (seen[tier.key] = seen[tier.key] || new Map());
    const players = (seenPlayers[tier.key] = seenPlayers[tier.key] || new Set());
    for (const i of found) {
      const a = i.getAuctionData();
      listings.set(a.tradeId, { item: i, price: a.buyNowPrice, until: Date.now() + a.expires * 1000 });
      players.add(i.definitionId);
    }
    return found;
  }

  // Check prices: the cheapest Buy Now of the CHECK_RATINGS gold ratings that look best value by EA's market
  // averages, and of Bronze. The cap rises until a listing shows up, then drops below the cheapest until none.
  async function checkPrices() {
    if (coolingDown()) return setMessage(`EA asked to slow down; price checks are paused until ${untilText()}.`);
    state.busy = true;
    render();
    let searches = 0;
    try {
      const limit = maxOvr();
      setMessage("Reading club and SBC Storage...");
      learn([...(await clubPlayers()), ...(await storagePlayers())]);
      const gold = tiers(limit).filter((t) => t.level === "gold");
      // The highest allowed rating always (score climbs fastest at the top), then the best value by estimate.
      const shortlist = [gold[0], ...gold.slice(1).filter((t) => estimates[t.rating]).sort((a, b) => estimates[a.rating] / a.score - estimates[b.rating] / b.score)]
        .filter(Boolean)
        .slice(0, CHECK_RATINGS);
      shortlist.push(tiers(limit).find((t) => t.key === "bronze"));
      const prices = storage.get(PRICES_KEY) || {};
      for (const tier of shortlist) {
        const step = (cap) => (cap < 1000 ? 50 : cap < 10000 ? 100 : 250);
        let cap = tier.level === "bronze" ? 200 : Math.max(200, Math.round((estimates[tier.rating] || 1000) / step(estimates[tier.rating] || 1000)) * step(estimates[tier.rating] || 1000));
        const search = async (maxBuy) => {
          if (searches) await sleep(PAUSE_MS);
          setMessage(`Checking ${tier.label}: up to ${fmt(maxBuy)}...`);
          return (await searchTier(tier, maxBuy, searches++, limit)).map((i) => i.getAuctionData().buyNowPrice);
        };
        let found = await search(cap);
        for (let n = 0; !found.length && n < 3; n++) found = await search((cap = Math.ceil((cap * 1.3) / step(cap)) * step(cap)));
        let lowest = found.length ? Math.min(...found) : null;
        for (let n = 0; lowest && n < 3; n++) {
          const lower = await search(below(lowest));
          if (!lower.length) break;
          lowest = Math.min(...lower);
        }
        if (lowest) {
          prices[tier.key] = { price: lowest, at: Date.now() };
          delete caps[tier.key];
        }
      }
      storage.set(PRICES_KEY, prices);
      state.plan = null;
      setMessage(`Prices checked with ${searches} market searches; kept for 30 minutes.`);
    } catch (e) {
      if (SLOW_DOWN.some((code) => e.message.includes(`status ${code}`))) {
        startCooldown();
        setMessage(`Stopped: EA asked to slow down (${e.message}). Price checks and buying are paused until ${untilText()}.`);
      } else setMessage(`Price check stopped: ${e.message}.`);
    } finally {
      state.busy = false;
      buildTable();
      render();
    }
  }

  // Buys `count` listings of a tier at or under its max price, cheapest first. A listing EA refuses with 461
  // (already sold) or 426 (refused for that listing) is skipped; any other refusal stops the run.
  async function buyTier(tier, count, limit) {
    const bought = [];
    const known = seen[tier.key] || new Map();
    const tryBuy = async (listings) => {
      for (const listing of listings.sort((a, b) => a.getAuctionData().buyNowPrice - b.getAuctionData().buyNowPrice)) {
        if (bought.length >= count) break;
        await sleep(BUY_PAUSE_MS);
        const price = listing.getAuctionData().buyNowPrice;
        known.delete(listing.getAuctionData().tradeId);
        const bid = await call(services.Item.bid(listing, price));
        const code = bid.error && Number(bid.error.code);
        if (bid.success) {
          bought.push(listing);
          leftovers.add(listing.id);
          saveLeftovers();
          state.spent += price;
          setMessage(`Buying ${tier.label}: ${bought.length} of ${count} bought...`);
        } else if (code !== 461 && code !== 426) {
          throw new Error(failure("Buy", bid));
        }
      }
    };
    // First the listings earlier searches saw (Check prices) that still run, then searches that alternate
    // between the players seen at this tier and the general search.
    await tryBuy([...known.values()].filter((s) => s.price <= tier.cap && s.until > Date.now() + 5000).map((s) => s.item));
    const players = [...(seenPlayers[tier.key] || [])];
    for (let n = 0; n < SEARCHES_PER_BUY && bought.length < count; n++) {
      await sleep(PAUSE_MS);
      const playerId = players.length && n % 2 === 0 ? players[(n / 2) % players.length] : null;
      setMessage(`Buying ${tier.label}: search ${n + 1}, ${bought.length} of ${count} bought...`);
      await tryBuy(await searchTier(tier, tier.cap, n, limit, playerId));
    }
    if (bought.length < count) throw new Error(`only ${bought.length} of ${count} ${tier.label} found at or under ${fmt(tier.cap)}`);
    return bought;
  }

  async function submit(plan, items) {
    // EA resets the challenge to "not started" after each completion and refuses a submit (403) until it is
    // started again, which the app does only when the challenge screen opens.
    const { challenge, set } = await freshChallenge();
    if (challenge.status !== "IN_PROGRESS") {
      const started = await call(services.SBC.initiateOneClickChallenge(challenge));
      if (!started.success) throw new Error(failure("Starting the challenge", started));
    }
    let completed = false;
    for (let k = 0; k < items.length; k += CARDS_PER_SUBMIT) {
      const ids = items.slice(k, k + CARDS_PER_SUBMIT).map((i) => Number(i.id));
      const sub = await call(services.SBC.submitOneClickChallenge(challenge, set, ids));
      if (!sub.success) throw new Error(failure("Submitting", sub));
      completed = !!(sub.data && sub.data.challengeCompleted);
    }
    for (const item of items) leftovers.delete(item.id);
    saveLeftovers();
    return completed;
  }

  // Batches: each buys at most the free Unassigned places of the plan (highest score first) and submits them with
  // the fodder; the next batch plans again from EA's submitted score.
  async function runRound() {
    state.busy = true;
    state.spent = 0;
    render();
    let fodderUsed = 0;
    try {
      for (let batch = 1; batch <= BATCHES; batch++) {
        const plan = (state.plan = await makePlan());
        let room = plan.room;
        const take = [];
        for (const [t, n] of [...plan.counts].sort((a, b) => b[0].score - a[0].score)) {
          const k = Math.min(n, room);
          if (k > 0) take.push([t, k]);
          room -= k;
        }
        if (plan.buys && !take.length) throw new Error("Unassigned is full; clear it first");
        let bought = [];
        for (const [t, k] of take) bought = bought.concat(await buyTier(t, k, plan.limit));
        const items = [...plan.kept, ...plan.fodder, ...bought];
        setMessage(`Submitting ${items.length} players${plan.buys > bought.length ? ` (batch ${batch})` : ""}...`);
        fodderUsed += plan.fodder.length;
        if (await submit(plan, items)) {
          state.plan = null;
          return setMessage(`Done: spent ${fmt(state.spent)} coins, used ${fodderUsed} fodder; the reward pack is in My Packs.`);
        }
        if (plan.buys <= bought.length) break;
      }
      setMessage(`Stopped: the challenge is not complete after ${BATCHES} batches. Spent ${fmt(state.spent)}.`);
    } catch (e) {
      const keep = leftovers.size ? ` ${leftovers.size} bought players wait in Unassigned and are used first next time.` : "";
      if (SLOW_DOWN.some((code) => e.message.includes(`status ${code}`))) {
        startCooldown();
        setMessage(`Stopped: EA asked to slow down (${e.message}). Buying is paused until ${untilText()}; runs without buying still work. Spent ${fmt(state.spent)}.${keep}`);
      } else {
        setMessage(`Stopped: ${e.message}. Spent ${fmt(state.spent)}.${keep}`);
      }
    } finally {
      state.busy = false;
      render();
    }
  }

  async function planOnly() {
    state.busy = true;
    render();
    try {
      state.plan = await makePlan();
      setMessage(describe(state.plan));
    } catch (e) {
      state.plan = null;
      setMessage(e.message);
    } finally {
      state.busy = false;
      buildTable();
      render();
    }
  }

  function setMessage(text) {
    state.message = text;
    render();
  }

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  function numberInput(value, onChange, placeholder) {
    const input = el("input");
    input.type = "number";
    input.min = "0";
    input.step = "50";
    input.placeholder = placeholder || "";
    input.value = value ? String(value) : "";
    input.addEventListener("change", () => {
      const v = Math.round(Number(input.value));
      onChange(input.value === "" || !Number.isFinite(v) || v < 0 ? 0 : v);
      state.plan = null;
      buildTable();
      render();
    });
    return input;
  }

  // The price table: rating · score · cheapest checked · coins per 1,000 score · max price · use. The best value
  // ticked row is marked.
  function buildTable() {
    const limit = maxOvr();
    const rows = tiers(limit);
    const best = rows.filter((t) => t.use).sort((a, b) => a.cap / a.score - b.cap / b.score)[0];
    for (const table of document.querySelectorAll(`.${PANEL_CLASS} .fc27-sbc-table`)) {
      const head = el("div", "fc27-sbc-row fc27-sbc-head");
      for (const text of ["", "Score", "Cheapest", "Per 1k", "Max", ""]) head.append(el("span", null, text));
      const body = rows.map((t) => {
        const row = el("div", "fc27-sbc-row");
        row.classList.toggle("is-best", t === best);
        row.classList.toggle("is-off", !t.use);
        const basis = t.cap || t.price || estimates[t.rating];
        const per = basis ? `${t.cap || t.price ? "" : "~"}${fmt(Math.round((basis / t.score) * 1000))}` : null;
        const tick = el("input");
        tick.type = "checkbox";
        tick.checked = !unticked.has(t.key);
        tick.addEventListener("change", () => {
          if (tick.checked) unticked.delete(t.key);
          else unticked.add(t.key);
          state.plan = null;
          buildTable();
          render();
        });
        row.append(
          el("span", "fc27-sbc-rating", t.label),
          el("span", null, fmt(t.score)),
          el("span", null, t.price ? fmt(t.price) : estimates[t.rating] ? `~${fmt(estimates[t.rating])}` : "–"),
          el("span", null, per || "–"),
          numberInput(caps[t.key] != null ? caps[t.key] : t.cap, (v) => (caps[t.key] = v), "–"),
          tick
        );
        return row;
      });
      table.replaceChildren(head, ...body);
    }
  }

  function build(panel) {
    panel.append(el("h3", "title", "Auto fill"), el("div", "fc27-sbc-table"));
    const limits = el("div", "fc27-sbc-limits");
    const budget = el("label", "fc27-sbc-field");
    budget.append(el("span", null, "Max coins per SBC"), numberInput(settings.budget, (v) => (settings.budget = v), "no limit"));
    const perBuy = el("label", "fc27-sbc-field");
    perBuy.append(el("span", null, "Cost per extra card"), numberInput(settings.perBuy, (v) => (settings.perBuy = v)));
    limits.append(budget, perBuy);
    const options = el("div", "fc27-sbc-options");
    for (const [key, text] of [
      ["useFodder", "Use untradeable club players"],
      ["allowSpecial", "Include special cards"],
    ]) {
      const label = el("label", "fc27-sbc-check");
      const input = el("input");
      input.type = "checkbox";
      input.checked = settings[key];
      input.addEventListener("change", () => {
        settings[key] = input.checked;
        state.plan = null;
        render();
      });
      label.append(input, el("span", null, text));
      options.append(label);
    }
    const check = el("button", "btn-standard fc27-sbc-check-prices", "Check prices");
    check.type = "button";
    check.addEventListener("click", () => !state.busy && checkPrices());
    const buttons = el("div", "fc27-sbc-buttons");
    const plan = el("button", "btn-standard fc27-sbc-plan", "Plan");
    plan.type = "button";
    plan.addEventListener("click", () => !state.busy && planOnly());
    const go = el("button", "btn-standard primary fc27-sbc-go", "Buy & submit");
    go.type = "button";
    go.addEventListener("click", () => !state.busy && state.plan && runRound());
    buttons.append(plan, go);
    panel.append(limits, options, check, buttons, el("div", "fc27-sbc-status"));
  }

  function render() {
    for (const panel of document.querySelectorAll(`.${PANEL_CLASS}`)) {
      for (const input of panel.querySelectorAll("input, button")) input.disabled = state.busy;
      panel.querySelector(".fc27-sbc-go").disabled = state.busy || !state.plan;
      panel.querySelector(".fc27-sbc-status").textContent = state.message;
    }
  }

  // The club's scores and market averages, read once per page in the background for the table's estimates.
  let clubRead = false;
  async function readClubOnce() {
    if (clubRead) return;
    clubRead = true;
    learn([...(await clubPlayers()), ...(await storagePlayers())]);
    buildTable();
    render();
  }

  // The panel goes under the requirements of a one-click score challenge (the score bar is on screen). The app
  // fills the requirements (with the OVR max) after the panel may already be there, so the table is drawn again
  // whenever the OVR max it was drawn for changes.
  function ensurePanel() {
    if (!document.querySelector(".ut-one-click-sbc-header-view--progress")) return;
    for (const req of document.querySelectorAll(".ut-sbc-challenge-requirements-view")) {
      if (!req.offsetParent) continue;
      let panel = req.parentElement.querySelector(`:scope > .${PANEL_CLASS}`);
      if (!panel) {
        panel = el("div", PANEL_CLASS);
        build(panel);
        req.after(panel);
        readClubOnce().catch(() => {});
      }
      const limit = String(maxOvr());
      if (panel.dataset.limit !== limit) {
        panel.dataset.limit = limit;
        buildTable();
        render();
      }
    }
  }

  new MutationObserver(ensurePanel).observe(document.body, { childList: true, subtree: true });
})();
