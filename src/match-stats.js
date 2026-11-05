// Shows Rivals, Champions and Squad Battles results next to coins and FC Points.
// Runs in the page world so it can use the Web App's own `services` object.
// Data is fetched once when the app is ready and again when the widget is clicked.
// The app only knows the current week (or Champions stage), so every period is saved
// through storage-bridge.js and the totals are summed from that history.
(() => {
  const WIDGET_ID = "fc27-match-stats";
  const NAVBAR_SELECTOR = ".view-navbar-currency";
  let current = null;
  let history = null;
  let loading = false;
  // Raw Champions hub body; the app's entity drops `eventCompleted` and fills missing numbers with 0.
  let champsRaw = null;

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (/\/champs2\/user\/hub$/.test(String(url).split("?")[0])) {
      this.addEventListener("load", () => {
        try {
          champsRaw = JSON.parse(this.responseText);
        } catch (e) {
          champsRaw = null;
        }
      });
    }
    return originalOpen.apply(this, arguments);
  };

  // Wraps the app's observable API in a promise; resolves with the response body.
  const request = (call) =>
    new Promise((resolve) => {
      const scope = {};
      const timer = setTimeout(() => resolve(null), 10000);
      try {
        call().observe(scope, (observable, result) => {
          observable.unobserve(scope);
          clearTimeout(timer);
          const body = result.success ? result.response || result.data : null;
          resolve(body ? body.event || body : null);
        });
      } catch (e) {
        clearTimeout(timer);
        resolve(null);
      }
    });

  // Reads ("history:get") or saves ("history:merge") periods; resolves with all saved periods for this persona.
  const bridge = (type, personaId, records) =>
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
        resolve(event.data.history);
      };
      window.addEventListener("message", onReply);
      window.postMessage({ source: "fc27-page", id, type, personaId, records }, location.origin);
    });

  // The app caches Rivals until the season ends and Champions until the stage ends,
  // so a manual refresh clears only these three event caches first.
  function clearEventCaches() {
    const repos = [
      () => services.Rivals.rivalsDao.eventRepository,
      () => services.Champions.championsDao.championsRepo,
      () => services.SquadBattles.squadBattlesDao.squadBattlesRepo,
    ];
    for (const repo of repos) {
      try {
        repo().reset();
      } catch (e) {
        // Leave the cache alone if the app changed its structure.
      }
    }
  }

  async function loadStats(fresh) {
    if (loading) return;
    loading = true;
    render();
    if (fresh === true) clearEventCaches();
    const [rivals, champs, battles] = await Promise.all([
      request(() => services.Rivals.getEvent()),
      request(() => services.Champions.requestChampsHub()),
      request(() => services.SquadBattles.requestCurrentEvent()),
    ]);
    // Let the XHR load listener above store the raw Champions body first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    current = { rivals: parseRivals(rivals), champs: parseChamps(champs), battles: parseBattles(battles) };
    const personaId = services.User.getUser().selectedPersona;
    if (current.rivals) {
      const saved = await bridge("history:get", personaId, []);
      current.rivals.value = rivalsWeek(saved && saved.rivals, current.rivals);
    }
    // A Rivals week is saved even with no games yet, so it replaces a wrong count saved for it earlier.
    const records = Object.entries(current)
      .filter(([mode, period]) => period && period.value && (period.value.played > 0 || mode === "rivals"))
      .map(([mode, period]) => ({ mode, key: period.key, value: period.value }));
    history = await bridge("history:merge", personaId, records);
    loading = false;
    render();
  }

  const divisionLabel = (name) => {
    const match = /^DIV_(.+)$/.exec(name || "");
    return match ? (/^\d+$/.test(match[1]) ? match[1] : match[1][0] + match[1].slice(1).toLowerCase()) : null;
  };

  // Header badge: a drawn shield (svg markup) with a short label over it.
  function shieldBadge(className, svg, label, title) {
    const badge = document.createElement("span");
    badge.className = `fc27-badge ${className}`;
    badge.title = title + " Click to refresh.";
    badge.innerHTML = svg;
    if (label) {
      const text = document.createElement("span");
      text.className = "fc27-badge-label";
      text.textContent = label;
      badge.append(text);
    }
    return badge;
  }

  // Rivals division: a square gold shield with a chevron and a hex gem, drawn like the in-game division icon.
  const DIVISION_SVG =
    '<svg viewBox="0 0 40 46" aria-hidden="true">' +
    '<defs><linearGradient id="fc27-division-gold" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#f6dc96"/><stop offset="0.55" stop-color="#c99a45"/><stop offset="1" stop-color="#8a6326"/></linearGradient>' +
    '<linearGradient id="fc27-division-face" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#4a3f2c"/><stop offset="1" stop-color="#17140f"/></linearGradient></defs>' +
    '<path d="M3 2H37V29L20 37L3 29Z" fill="url(#fc27-division-gold)"/>' +
    '<path d="M6 5H34V27.2L20 33.8L6 27.2Z" fill="url(#fc27-division-face)"/>' +
    '<path d="M20 9L29 15.5L25.5 26H14.5L11 15.5ZM20 9V5M29 15.5L34 13M25.5 26L28 31.5M14.5 26L12 31.5M11 15.5L6 13" ' +
    'fill="none" stroke="#e8c77a" stroke-opacity="0.28" stroke-width="0.8"/>' +
    '<path d="M3 32L20 40L37 32V35L20 43L3 35Z" fill="url(#fc27-division-gold)"/>' +
    '<path d="M20 37.6L23.4 39.6V43.4L20 45.4L16.6 43.4V39.6Z" fill="url(#fc27-division-gold)" stroke="#5c421a" stroke-width="0.6"/>' +
    '<path d="M20 39.6L21.7 40.6V42.4L20 43.4L18.3 42.4V40.6Z" fill="#5c421a" fill-opacity="0.55"/>' +
    "</svg>";

  // Champions rank: a round-topped gold shield with side wings, a red crystal face and a red hex gem,
  // drawn like the in-game rank icon.
  const CHAMPS_SVG =
    '<svg viewBox="0 0 48 50" aria-hidden="true">' +
    '<defs><linearGradient id="fc27-champs-gold" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#f6dc96"/><stop offset="0.55" stop-color="#c99a45"/><stop offset="1" stop-color="#8a6326"/></linearGradient>' +
    '<radialGradient id="fc27-champs-face" cx="0.4" cy="0.35" r="0.75">' +
    '<stop offset="0" stop-color="#a8352b"/><stop offset="0.6" stop-color="#5e1611"/><stop offset="1" stop-color="#2a0806"/></radialGradient></defs>' +
    '<path d="M8 11C3 19 3 30 10 39L12.5 37C7.5 30 7.5 20 10.5 13ZM40 11C45 19 45 30 38 39L35.5 37C40.5 30 40.5 20 37.5 13Z" fill="url(#fc27-champs-gold)"/>' +
    '<path d="M7 7Q24 1 41 7V22C41 34 33 42 24 46C15 42 7 34 7 22Z" fill="url(#fc27-champs-gold)"/>' +
    '<path d="M10 9.4Q24 4.6 38 9.4V22C38 32.4 31.5 39.4 24 42.8C16.5 39.4 10 32.4 10 22Z" fill="url(#fc27-champs-face)"/>' +
    '<path d="M24 11L33 17.5L30 29H18L15 17.5ZM24 11V6M33 17.5L38 15M30 29L33 35M18 29L15 35M15 17.5L10 15" ' +
    'fill="none" stroke="#ff8a70" stroke-opacity="0.35" stroke-width="0.8"/>' +
    '<path d="M13 12L19 16M31 9L35 13M28 31L34 27M14 26L18 33" fill="none" stroke="#e8c77a" stroke-opacity="0.45" stroke-width="0.5"/>' +
    '<path d="M24 41.4L27.4 43.4V47.2L24 49.2L20.6 47.2V43.4Z" fill="#b3261c" stroke="url(#fc27-champs-gold)" stroke-width="1.2"/>' +
    "</svg>";

  const divisionName = (label) => (/^\d+$/.test(label) ? `Division ${label}` : label);

  function divisionBadge(d) {
    const title =
      `Rivals ${divisionName(d.label)}.` +
      (d.next ? ` Next: ${divisionName(d.next)}.` : "") +
      (d.promotion ? " Next match is a promotion match." : "") +
      (d.relegation ? " Next match is a relegation match." : "");
    return shieldBadge("fc27-division", DIVISION_SVG, /^\d+$/.test(d.label) ? d.label : d.label[0], title);
  }

  // The rank of the latest Champions run the extension saved, other than a run still in progress. The app
  // returns no results for a finished run, so wins come from the last refresh before it ended; ranks follow
  // the hub's tier table (tierStart <= wins < tierEnd).
  function lastChampsRank() {
    const c = current && current.champs;
    const tiers = (c && c.stage && c.stage.prizeTiers) || [];
    const running = c && !c.state ? c.key : null;
    const run = Object.entries((history && history.champs) || {})
      .filter(([key]) => key !== running)
      .map(([key, value]) => ({ start: Number(key.split(":")[1]), ...value }))
      .sort((x, y) => y.start - x.start)[0];
    if (!run) return null;
    const tier = tiers.find((t) => run.won >= t.tierStart && run.won < t.tierEnd);
    return { ...run, rank: tier ? tier.tierLevel : null };
  }

  function champsBadge(run) {
    if (!run || run.rank == null) {
      const title = run
        ? `Last tracked Champions run: ${run.won} won of ${run.played}, no rank.`
        : "No previous Champions rank: the extension has not saved a finished run for this account.";
      return shieldBadge("fc27-champs is-empty", CHAMPS_SVG, "", title);
    }
    const date = new Date(run.start * 1000).toLocaleDateString();
    const title =
      `Last tracked Champions run (from ${date}): Rank ${run.rank}, ${run.won} won of ${run.played}. ` +
      "Games after the last refresh before the run ended are not counted.";
    return shieldBadge("fc27-champs", CHAMPS_SVG, String(run.rank), title);
  }

  // Squad Battles rank: the app's own badge image and name, chosen as in UTSquadBattlesProgressionHeaderView:
  // tier 1 (Elite 1) to 12 (Bronze 3) use SquadBattles_<group>_<step>.png, a leaderboard position (top 200)
  // uses the "ranked" image, and no tier yet the "Unranked" one. Paths are relative to the Web App.
  function battlesBadge(b) {
    const loc = services.Localization;
    const image = b.rank > 0 ? "ranked" : b.tier > 0 ? `${Math.floor((b.tier - 1) / 3)}_${((b.tier - 1) % 3) + 1}` : "Unranked";
    const name =
      b.rank > 0 ? loc.localize("squadbattles.rank.title", [String(b.rank)])
        : b.tier > 0 ? loc.localize(`squadbattles.tier${b.tier}.title`)
          : loc.localize("squadbattles.noprogress.title");
    const next = b.rank > 0 ? null : b.tiers.find((t) => t.level === b.tier - 1 && t.startPoints > 0);
    const score = b.value.score.toLocaleString();
    const title =
      `Squad Battles: ${name}, ${score} points this week.` +
      (next ? ` ${loc.localize(`squadbattles.tier${next.level}.title`)} from ${next.startPoints.toLocaleString()} points (${(next.startPoints - b.value.score).toLocaleString()} to go).` : "");
    const badge = document.createElement("span");
    badge.className = "fc27-badge fc27-battles";
    badge.title = title + " Click to refresh.";
    const img = document.createElement("img");
    img.src = `images/gameModes/squadBattles/SquadBattles_${image}.png`;
    img.alt = "";
    badge.append(img);
    if (b.rank > 0) {
      const text = document.createElement("span");
      text.className = "fc27-badge-label";
      text.textContent = String(b.rank);
      badge.append(text);
    }
    return badge;
  }

  // Rivals reports matchesWon for the current week but matchesPlayed for the season: at the weekly reset
  // (5 Nov 2026) wins went back to 0 while played stayed at 5. A Rivals match always has a winner, so the
  // week's losses are its games minus its wins. The week is identified by the next weekly reward time.
  function parseRivals(ev) {
    const user = ev && ev.user;
    if (!user || !ev.season) return null;
    const weekEnd = (ev.season.rewardTimeStamps || []).find((t) => t >= ev.currentTime) || ev.season.endTime;
    const division = ev.division || {};
    return {
      key: `${ev.season.seasonId}:${weekEnd}`,
      division: {
        // The names are text keys such as "DIV_7" or "DIV_ELITE" that the app has no translation for.
        label: divisionLabel(division.localizedName) || String(user.divisionId),
        next: divisionLabel(division.nextDivisionLocalizedName),
        promotion: user.isPromotionMatch === true,
        relegation: user.isRelegationMatch === true,
      },
      value: { won: user.matchesWon || 0, played: user.matchesPlayed || 0, seasonPlayed: user.matchesPlayed || 0 },
    };
  }

  // The week's games: the season count now minus the season count last saved in the previous week of the same
  // season (records before 1.15 kept it in `played`). Games played after that last save but before the reset
  // are counted in the new week. Without a saved previous week the week's games are not known, so the season
  // count is shown; it can include earlier weeks.
  function rivalsWeek(saved, now) {
    const [season, weekEnd] = now.key.split(":");
    const previous = Object.entries(saved || {})
      .filter(([key]) => key.split(":")[0] === season && Number(key.split(":")[1]) < Number(weekEnd))
      .sort(([a], [b]) => Number(b.split(":")[1]) - Number(a.split(":")[1]))[0];
    const value = now.value;
    if (!previous) return value;
    const before = previous[1].seasonPlayed != null ? previous[1].seasonPlayed : previous[1].played;
    return { ...value, played: Math.max(value.won, value.seasonPlayed - before) };
  }

  // Champions gives points per win and per loss, so wins are derived from points. There are no draws.
  // A finished run or a stage not entered has no gamesPlayed in the server response, so nothing is saved.
  function parseChamps(ev) {
    if (!ev) return null;
    const stages = ev.stages || [];
    const stage = stages.find((s) => s.stageEventId === ev.currentStageId) || stages[0] || {};
    if (champsRaw && champsRaw.eventCompleted) return { state: "done", stage };
    if (champsRaw && champsRaw.gamesPlayed == null) return { state: "not entered", stage };
    if (ev.gamesPlayed == null) return null;
    const played = ev.gamesPlayed;
    const perWin = stage.pointsPerWin || 1;
    const perLoss = stage.pointsPerLoss || 0;
    const won = perWin === perLoss ? 0 : Math.round((ev.currentPoints - perLoss * played) / (perWin - perLoss));
    return { key: `${stage.stageEventId}:${stage.startTime}`, value: { won, played }, maxGames: stage.maxGames, stage };
  }

  // Squad Battles only reports games played and score.
  function parseBattles(ev) {
    if (!ev || ev.gamesPlayed == null) return null;
    return {
      key: String(ev.id),
      value: { played: ev.gamesPlayed, score: ev.score || 0 },
      maxGames: ev.maxRegularGames,
      tier: ev.userCurrentTierLevel || 0,
      rank: ev.rank || 0,
      tiers: ev.prizeTiers || [],
    };
  }

  const winRate = (won, played) => (played > 0 ? Math.round((won / played) * 100) + "%" : "-");

  const total = (mode) => {
    const periods = Object.values((history && history[mode]) || {});
    return periods.reduce(
      (sum, p) => ({
        won: sum.won + (p.won || 0),
        played: sum.played + p.played,
        score: sum.score + (p.score || 0),
        periods: sum.periods + 1,
      }),
      { won: 0, played: 0, score: 0, periods: 0 }
    );
  };

  // Returns [label, this period line, total line, tooltip] for each mode.
  function describe() {
    const since = history ? new Date(history.since).toLocaleDateString() : null;
    const totalNote = since ? "" : " Totals are unavailable because the extension storage did not answer.";
    const rows = [];

    const r = current.rivals && current.rivals.value;
    const rt = total("rivals");
    rows.push([
      "Rivals",
      r ? `W${r.won} L${r.played - r.won}` : "n/a",
      since ? `All W${rt.won} L${rt.played - rt.won}` : "",
      (r ? `This week: ${r.won} won of ${r.played} (win rate ${winRate(r.won, r.played)}). ` : "") +
        (since ? `Since ${since}: ${rt.won} won of ${rt.played} in ${rt.periods} week(s) (win rate ${winRate(rt.won, rt.played)}).` : "") +
        totalNote,
    ]);

    const c = current.champs;
    const ct = total("champs");
    const stageEnd = c && c.stage && c.stage.endTime ? new Date(c.stage.endTime * 1000).toLocaleString() : "?";
    const champsNow = !c ? "n/a" : c.state ? c.state : `W${c.value.won} L${c.value.played - c.value.won}`;
    const champsNote = !c
      ? ""
      : c.state === "done"
        ? `This stage (until ${stageEnd}): run completed. The server does not return results of a finished run. `
        : c.state === "not entered"
          ? `This stage (until ${stageEnd}): not entered. `
          : `This stage: ${c.value.won} won, ${c.value.played - c.value.won} lost, ${c.value.played}${c.maxGames ? "/" + c.maxGames : ""} played. `;
    rows.push([
      "Champs",
      champsNow,
      since ? `All W${ct.won} L${ct.played - ct.won}` : "",
      champsNote +
        (since ? `Since ${since}: ${ct.won} won, ${ct.played - ct.won} lost in ${ct.periods} stage(s) (win rate ${winRate(ct.won, ct.played)}).` : "") +
        totalNote,
    ]);

    const b = current.battles;
    const bt = total("battles");
    rows.push([
      "SB",
      b ? `P${b.value.played}${b.maxGames ? "/" + b.maxGames : ""}` : "n/a",
      since ? `All P${bt.played}` : "",
      (b ? `This week: ${b.value.played} games played, score ${b.value.score}. ` : "") +
        (since ? `Since ${since}: ${bt.played} games in ${bt.periods} week(s). ` : "") +
        "The app does not report wins." + totalNote,
    ]);

    return rows;
  }

  function render() {
    const navbar = document.querySelector(NAVBAR_SELECTOR);
    if (!navbar) return;
    let widget = document.getElementById(WIDGET_ID);
    if (!widget || widget.parentElement !== navbar) {
      widget?.remove();
      widget = document.createElement("div");
      widget.id = WIDGET_ID;
      widget.addEventListener("click", () => loadStats(true));
      navbar.prepend(widget);
    }
    widget.classList.toggle("is-loading", loading);
    const rows = current ? describe() : ["Rivals", "Champs", "SB"].map((label) => [label, loading ? "..." : "n/a", "", ""]);
    const items = rows.map(([label, week, all, title]) => {
      const el = document.createElement("span");
      el.className = "fc27-match-stats-item";
      el.title = (title ? title + " " : "") + "Click to refresh.";
      const top = document.createElement("span");
      top.textContent = `${label} ${week}`;
      el.append(top);
      if (all) {
        const bottom = document.createElement("span");
        bottom.className = "fc27-match-stats-total";
        bottom.textContent = all;
        el.append(bottom);
      }
      return el;
    });
    // Each badge stands before its own box: the division before Rivals, the last rank before Champs,
    // the current rank before SB.
    if (current) {
      if (current.rivals) items.unshift(divisionBadge(current.rivals.division));
      items.splice(items.length - 2, 0, champsBadge(lastChampsRank()));
      if (current.battles) items.splice(items.length - 1, 0, battlesBadge(current.battles));
    }
    widget.replaceChildren(...items);
  }

  // The navbar is re-rendered on navigation, so put the widget back whenever it disappears.
  new MutationObserver(() => {
    const navbar = document.querySelector(NAVBAR_SELECTOR);
    if (navbar && !navbar.querySelector("#" + WIDGET_ID)) render();
  }).observe(document.body, { childList: true, subtree: true });

  // Wait until the user is logged in and the app's services are available.
  const ready = setInterval(() => {
    try {
      if (window.services && services.User.getUser() && document.querySelector(NAVBAR_SELECTOR)) {
        clearInterval(ready);
        loadStats();
      }
    } catch (e) {
      // App not ready yet.
    }
  }, 1000);
})();
