/*
 * Crunchyroll Listenfilter – Seiten-Script (läuft in der Welt der Webseite)
 *
 * 1. API-Filter
 *    Crunchyroll lädt Reihen wie "Schau weiter", "Watchlist" oder die
 *    Empfehlungen per XHR/fetch aus /content/v2/discover/... bzw.
 *    /personalization/.... Dieses Script filtert die JSON-Antworten, BEVOR
 *    Crunchyroll sie rendert. Dadurch entstehen keine Lücken im Karussell.
 *
 *    Ausgefiltert werden:
 *    - Serien der Kategorie "Uninteressant" (immer)
 *    - Serien der Kategorie "Gesehen", solange seit dem Markieren nichts Neues
 *      veröffentlicht wurde (Vergleich: last_public der Serie bzw.
 *      Veröffentlichungsdatum der Folge gegen das Markierungsdatum)
 *    - in "Schau weiter" und Watchlist: fertig geschaute Folgen (fully_watched)
 *
 * 2. Crunchylisten-Sync
 *    Beide Kategorien liegen als private Crunchylisten im Konto:
 *    "Ausgeblendet (Listenfilter)" und "Gesehen (Listenfilter)".
 *    Das Markierungsdatum einer gesehenen Serie ist das Änderungsdatum
 *    (modified_at) ihres Listeneintrags – damit synchronisiert es mit.
 *
 * 3. Karten
 *    "✓ Gesehen" / "✕ Uninteressant" auf jeder Karte, "✨ Neu"-Hinweis bei
 *    gesehenen Serien mit neuen Folgen. Die Serien-ID kommt aus Link und
 *    API-Daten – nie aus sichtbarem Kartentext.
 */

(() => {
  if (window.__crlfPageLoaded) return;
  window.__crlfPageLoaded = true;

  const PAGE_CACHE_KEY = "CRLF_PAGE_STATE_V3";
  const LIST_TITLES = {
    blocked: "Ausgeblendet (Listenfilter)",
    seen: "Gesehen (Listenfilter)"
  };
  const DEFAULT_LIST_MAX = 100;
  const MAX_PRIVATE_LISTS = 10;
  const EXTRA_ITEMS = 40; // Zusatzeinträge, damit kurze Reihen nach dem Filtern voll bleiben
  const WATCHLIST_FULL_N = 1000;
  const PERIODIC_SYNC_MS = 15 * 60_000;
  const SEEN_RECHECK_MS = 6 * 60 * 60_000; // "Gibt es Neues?" höchstens alle 6 h pro Serie prüfen
  const SEEN_CHECKS_PER_SYNC = 25;
  const NEW_MARGIN_MS = 60_000;
  const OWNER = Math.random().toString(36).slice(2);
  const LOG = "[Crunchyroll Listenfilter]";

  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const ACCOUNT_IN_PATH = new RegExp(`^/content/v2/(?:discover/)?(${UUID})/`, "i");
  const CONTENT_TYPES = new Set(["series", "episode", "movie", "movie_listing", "season"]);

  const origFetch = window.fetch.bind(window);

  // ---------------------------------------------------------------------------
  // Zustand
  // ---------------------------------------------------------------------------

  let state = readCache() || {};
  let blockedIds = new Set();
  let blockedTitles = new Set();
  let seenMarked = new Map(); // Serien-ID -> markedAt (ms)
  let seenNew = new Set(); // Serien mit bestätigt neuen Folgen (aus dem Sync)
  normalizeState();

  let token = null; // { value: "Bearer …", exp: epochSeconds }
  let accountId = null;
  let locale = "de-DE";

  // Aus API-Antworten gesammelt:
  const episodeToSeries = new Map(); // Episoden-/Film-ID -> { id, title }
  const episodeDates = new Map(); // Episoden-/Film-ID -> Veröffentlichung (ms)
  const seriesTitles = new Map(); // Serien-ID -> Titel
  const seriesLastPublic = new Map(); // Serien-ID -> last_public (ms)

  function readCache() {
    try {
      return JSON.parse(window.localStorage.getItem(PAGE_CACHE_KEY) || "null");
    } catch {
      return null;
    }
  }

  function normalizeState() {
    state = {
      ids: {},
      titles: [],
      seen: {},
      seenNew: [],
      settings: { hideCompleted: true, showButtons: true },
      pendingCount: 0,
      ...state
    };
    blockedIds = new Set(Object.keys(state.ids || {}));
    blockedTitles = new Set(state.titles || []);
    seenMarked = new Map(Object.entries(state.seen || {}).map(([id, v]) => [id, Number(v.markedAt) || Date.now()]));
    seenNew = new Set(state.seenNew || []);
  }

  function applyState(next) {
    state = next;
    normalizeState();
    scheduleScan();
    if (state.pendingCount > 0) scheduleSync(1500);
  }

  function normalizeTitle(title) {
    return (title || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[“”„"'’`´]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  function toMs(value) {
    const ms = Date.parse(value || "");
    return Number.isFinite(ms) ? ms : 0;
  }

  // ---------------------------------------------------------------------------
  // Kommunikation mit content.js
  // ---------------------------------------------------------------------------

  const waiting = new Map();

  function toContent(message) {
    window.postMessage({ crlf: "toContent", ...message }, location.origin);
  }

  function askContent(message, timeoutMs = 5000) {
    const requestId = Math.random().toString(36).slice(2);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        resolve(null);
      }, timeoutMs);
      waiting.set(requestId, reply => {
        clearTimeout(timer);
        resolve(reply);
      });
      toContent({ ...message, requestId });
    });
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.crlf !== "toPage") return;

    if (msg.requestId && waiting.has(msg.requestId)) {
      const cb = waiting.get(msg.requestId);
      waiting.delete(msg.requestId);
      cb(msg);
      return;
    }

    if (msg.t === "state" && msg.state) applyState(msg.state);
    if (msg.t === "syncNow") scheduleSync(0, true);
  });

  // ---------------------------------------------------------------------------
  // Hilfsfunktionen für Crunchyroll-Objekte
  // ---------------------------------------------------------------------------

  function panelOf(item) {
    return item?.panel && typeof item.panel === "object" ? item.panel : item;
  }

  /** Liefert { id, title } der Serie bzw. des Film-Listings zu einem Eintrag. */
  function seriesOf(item) {
    if (!item || typeof item !== "object") return null;
    const p = panelOf(item);

    if (p.episode_metadata?.series_id) {
      return { id: p.episode_metadata.series_id, title: p.episode_metadata.series_title };
    }
    if (p.movie_metadata?.movie_listing_id) {
      return { id: p.movie_metadata.movie_listing_id, title: p.movie_metadata.movie_listing_title };
    }
    if (p.type === "series" || p.type === "movie_listing") {
      return { id: p.id, title: p.title };
    }
    if (p.type === "season" && p.series_id) {
      return { id: p.series_id, title: p.series_title || p.title };
    }
    if (p.series_id) {
      return { id: p.series_id, title: p.series_title };
    }
    return null;
  }

  /** Veröffentlichungsdatum eines Eintrags (Serie: last_public, Folge: Freigabe). */
  function publishedAt(item) {
    const p = panelOf(item);
    const direct = toMs(item?.last_public) || toMs(p?.last_public);
    if (direct) return direct;

    const m = p?.episode_metadata || p?.movie_metadata;
    if (!m) return 0;
    return toMs(m.premium_available_date) || toMs(m.availability_starts) || toMs(m.episode_air_date) || toMs(m.free_available_date);
  }

  function isContentItem(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return false;
    if (o.panel && typeof o.panel === "object") return true;
    return typeof o.id === "string" && CONTENT_TYPES.has(o.type);
  }

  /**
   * Hat eine gesehene Serie seit dem Markieren Neues?
   * - bestätigt durch den Sync-Check (up_next), oder
   * - der konkrete Eintrag (Folge/Serie) wurde nach dem Markieren veröffentlicht, oder
   * - last_public der Serie (aus anderen Antworten gesammelt) liegt danach.
   */
  function seenHasNew(seriesId, item) {
    if (seenNew.has(seriesId)) return true;
    const markedAt = seenMarked.get(seriesId) || 0;
    const itemDate = item ? publishedAt(item) : 0;
    if (itemDate > markedAt + NEW_MARGIN_MS) return true;
    return (seriesLastPublic.get(seriesId) || 0) > markedAt + NEW_MARGIN_MS;
  }

  /** "blocked", "seen" oder null */
  function hiddenReason(item) {
    const s = seriesOf(item);
    if (!s) return null;
    if (s.id && blockedIds.has(s.id)) return "blocked";
    if (s.title && blockedTitles.size > 0 && blockedTitles.has(normalizeTitle(s.title))) return "blocked";
    if (s.id && seenMarked.has(s.id) && !seenHasNew(s.id, item)) return "seen";
    return null;
  }

  /** "Erneut ansehen": Crunchyroll markiert komplett gesehene Folgen mit fully_watched. */
  function isCompleted(item) {
    if (item.fully_watched === true) return true;
    const durationMs = item.panel?.episode_metadata?.duration_ms || item.panel?.movie_metadata?.duration_ms;
    if (typeof item.playhead === "number" && durationMs > 0) {
      return item.playhead * 1000 >= durationMs * 0.97;
    }
    return false;
  }

  /** Sammelt Zuordnungen und Daten, damit Karten und Filter mehr wissen. */
  function collect(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 8) return;

    if (Array.isArray(node)) {
      for (const child of node) collect(child, depth + 1);
      return;
    }

    if (isContentItem(node)) {
      const p = panelOf(node);
      const s = seriesOf(node);
      if (s?.id) {
        if (s.title) seriesTitles.set(s.id, s.title);
        if (p.id && p.id !== s.id) {
          episodeToSeries.set(p.id, s);
          const d = publishedAt(node);
          if (d) episodeDates.set(p.id, d);
        } else {
          const lp = toMs(node.last_public) || toMs(p.last_public);
          if (lp) seriesLastPublic.set(s.id, Math.max(lp, seriesLastPublic.get(s.id) || 0));
        }
      }
    }

    for (const key in node) {
      const v = node[key];
      if (v && typeof v === "object" && key !== "images") collect(v, depth + 1);
    }
  }

  /** Entfernt rekursiv alle unerwünschten Einträge aus Listen in der Antwort. */
  function filterTree(node, dropCompleted, depth = 0) {
    if (!node || typeof node !== "object" || depth > 6) return 0;
    let removed = 0;

    if (Array.isArray(node)) {
      if (node.some(isContentItem)) {
        for (let i = node.length - 1; i >= 0; i--) {
          const item = node[i];
          if (!isContentItem(item)) continue;
          if (hiddenReason(item) || (dropCompleted && isCompleted(item))) {
            node.splice(i, 1);
            removed++;
          }
        }
      }
      for (const child of node) removed += filterTree(child, dropCompleted, depth + 1);
      return removed;
    }

    for (const key in node) {
      const v = node[key];
      if (v && typeof v === "object" && key !== "panel" && key !== "images") {
        removed += filterTree(v, dropCompleted, depth + 1);
      }
    }
    return removed;
  }

  // ---------------------------------------------------------------------------
  // Anfragen erkennen und Antworten umschreiben
  // ---------------------------------------------------------------------------

  const fullWatchlists = new Set();

  /** Schlüssel für eine Watchlist-Ansicht (Sortierung/Filter), ohne Paging. */
  function watchlistKey(u) {
    const params = [...u.searchParams].filter(([k]) => k !== "n" && k !== "start").sort();
    return `${u.pathname}?${new URLSearchParams(params)}`;
  }

  function observeUrl(u) {
    const m = u.pathname.match(ACCOUNT_IN_PATH);
    if (m) accountId = m[1];
    const loc = u.searchParams.get("locale");
    if (loc) locale = loc;
  }

  /** Entscheidet, ob und wie eine API-Anfrage behandelt wird (null = nicht anfassen). */
  function planRequest(rawUrl) {
    let u;
    try {
      u = new URL(rawUrl, location.href);
    } catch {
      return null;
    }
    if (u.origin !== location.origin) return null;
    observeUrl(u);

    const path = u.pathname;
    const isContent = path.startsWith("/content/v2/");
    const isPersonalization = path.startsWith("/personalization/");
    if (!isContent && !isPersonalization) return null;

    const isDiscoverList =
      path.startsWith("/content/v2/discover/") &&
      !/\/discover\/(up_next|search|seasonal_tags|categories)\b/.test(path);

    const isHistory = new RegExp(`^/content/v2/discover/${UUID}/history$`, "i").test(path);
    const isWatchlist = new RegExp(`^/content/v2/discover/${UUID}/watchlist$`, "i").test(path);

    const plan = {
      url: u.href,
      filter: isDiscoverList || isPersonalization,
      dropCompleted: isHistory || isWatchlist,
      trimTo: null
    };

    // Watchlist-Seite (mit order=…): Crunchyroll lädt nur weiter, wenn die
    // erste Seite voll war. Nach dem Filtern ist sie das nie – deshalb die
    // komplette Watchlist auf einmal holen und "total" anpassen.
    if (isWatchlist && u.searchParams.has("order")) {
      const key = watchlistKey(u);
      if (!u.searchParams.has("start") || u.searchParams.get("start") === "0") {
        u.searchParams.set("n", String(WATCHLIST_FULL_N));
        plan.url = u.href;
        plan.fullListKey = key;
      } else if (fullWatchlists.has(key)) {
        plan.emptyResult = true;
      }
      return plan;
    }

    // Kurze Reihen (z. B. "Schau weiter" mit n=20) größer anfordern und nach
    // dem Filtern wieder auf die ursprüngliche Größe kürzen.
    if ((isHistory || isWatchlist) && !u.searchParams.has("start")) {
      const n = Number(u.searchParams.get("n"));
      if (n > 0 && n <= 50) {
        u.searchParams.set("n", String(n + EXTRA_ITEMS));
        plan.url = u.href;
        plan.trimTo = n;
      }
    }

    return plan;
  }

  function transformJson(plan, json) {
    if (!json || typeof json !== "object") return json;

    try {
      collect(json);
    } catch {
      /* Metadaten sind nur ein Bonus */
    }

    if (!plan.filter) return json;

    const dropCompleted = plan.dropCompleted && state.settings?.hideCompleted !== false;
    filterTree(json, dropCompleted);

    if (Array.isArray(json.data)) {
      if (plan.trimTo && json.data.length > plan.trimTo) json.data = json.data.slice(0, plan.trimTo);
      if (plan.emptyResult) json.data = [];
      if (plan.fullListKey) {
        json.total = json.data.length;
        fullWatchlists.add(plan.fullListKey);
      }
    }

    scheduleScan();
    return json;
  }

  function transformText(plan, text) {
    if (!text || (text[0] !== "{" && text[0] !== "[")) return text;
    try {
      return JSON.stringify(transformJson(plan, JSON.parse(text)));
    } catch {
      return text;
    }
  }

  // --- XMLHttpRequest (Crunchyroll nutzt axios = XHR) ------------------------

  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSetRequestHeader = XHR.setRequestHeader;
  const responseTextDesc = Object.getOwnPropertyDescriptor(XHR, "responseText");
  const responseDesc = Object.getOwnPropertyDescriptor(XHR, "response");

  XHR.open = function (method, url, ...rest) {
    this.__crlfPlan = null;
    this.__crlfCache = undefined;
    try {
      const plan = planRequest(String(url));
      if (plan && String(method).toUpperCase() === "GET") {
        this.__crlfPlan = plan;
        url = plan.url;
      }
    } catch {
      /* nie die Seite kaputt machen */
    }
    return origOpen.call(this, method, url, ...rest);
  };

  XHR.setRequestHeader = function (name, value) {
    if (/^authorization$/i.test(name)) captureToken(value);
    return origSetRequestHeader.call(this, name, value);
  };

  function xhrTransformed(xhr, raw, asJson) {
    if (xhr.__crlfCache !== undefined) return xhr.__crlfCache;
    let out = raw;
    try {
      if (xhr.status >= 200 && xhr.status < 300) {
        out = asJson ? transformJson(xhr.__crlfPlan, raw) : transformText(xhr.__crlfPlan, raw);
      }
    } catch (error) {
      console.warn(LOG, "Antwort konnte nicht gefiltert werden:", error);
    }
    xhr.__crlfCache = out;
    return out;
  }

  Object.defineProperty(XHR, "responseText", {
    configurable: true,
    enumerable: responseTextDesc.enumerable,
    get() {
      const raw = responseTextDesc.get.call(this);
      if (!this.__crlfPlan || this.readyState !== 4) return raw;
      return xhrTransformed(this, raw, false);
    }
  });

  Object.defineProperty(XHR, "response", {
    configurable: true,
    enumerable: responseDesc.enumerable,
    get() {
      const raw = responseDesc.get.call(this);
      if (!this.__crlfPlan || this.readyState !== 4) return raw;
      const type = this.responseType;
      if (type === "" || type === "text") return xhrTransformed(this, raw, false);
      if (type === "json") return xhrTransformed(this, raw, true);
      return raw;
    }
  });

  // --- fetch ----------------------------------------------------------------

  window.fetch = async function (input, init) {
    let plan = null;

    try {
      const isRequest = typeof Request !== "undefined" && input instanceof Request;
      const url = isRequest ? input.url : String(input);
      const method = (init?.method || (isRequest ? input.method : "GET") || "GET").toUpperCase();

      const headers = new Headers(init?.headers || (isRequest ? input.headers : undefined));
      const auth = headers.get("authorization");
      if (auth) captureToken(auth);

      plan = method === "GET" ? planRequest(url) : null;
      if (plan && plan.url !== new URL(url, location.href).href) {
        input = isRequest ? new Request(plan.url, input) : plan.url;
      }
    } catch {
      plan = null;
    }

    const response = await origFetch(input, init);
    if (!plan || !response.ok) return response;

    try {
      const text = await response.clone().text();
      const out = transformText(plan, text);
      if (out === text) return response;
      return new Response(out, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch {
      return response;
    }
  };

  // ---------------------------------------------------------------------------
  // Zugriffstoken der Seite
  // ---------------------------------------------------------------------------

  function captureToken(value) {
    if (!/^Bearer\s+\S+/i.test(value || "")) return;
    let exp = 0;
    try {
      const payload = value.split(" ")[1].split(".")[1];
      const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
      exp = Number(json.exp) || 0;
    } catch {
      exp = Math.floor(Date.now() / 1000) + 240;
    }

    const isNew = !token || token.value !== value;
    token = { value, exp };

    if (isNew && (waitingForToken || !initialSyncDone)) scheduleSync(800);
  }

  function tokenValid() {
    return token && token.exp * 1000 > Date.now() + 20_000;
  }

  // ---------------------------------------------------------------------------
  // Crunchyroll-API
  // ---------------------------------------------------------------------------

  class NoTokenError extends Error {}

  async function api(method, path, body) {
    if (!tokenValid() || !accountId) throw new NoTokenError("Kein gültiges Crunchyroll-Token");

    const res = await origFetch(path, {
      method,
      credentials: "include",
      headers: {
        Authorization: token.value,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (res.status === 401) {
      token = null;
      throw new NoTokenError("Token abgelaufen");
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      const error = new Error(`HTTP ${res.status} bei ${method} ${path.replace(accountId, "…")}: ${text.slice(0, 200)}`);
      error.status = res.status;
      throw error;
    }
    return json;
  }

  const q = () => `locale=${encodeURIComponent(locale)}`;

  function listsBase() {
    return `/content/v2/${accountId}/custom-lists`;
  }

  async function fetchLists() {
    const r = await api("GET", `${listsBase()}?${q()}`);
    return Array.isArray(r?.data) ? r.data : [];
  }

  function listFamily(list) {
    const title = (list.title || "").trim();
    for (const [family, base] of Object.entries(LIST_TITLES)) {
      if (title === base || title.startsWith(`${base} `)) return family;
    }
    return null;
  }

  async function fetchListItems(listId) {
    const items = [];
    let max = DEFAULT_LIST_MAX;

    for (let page = 1; page <= 5; page++) {
      const r = await api("GET", `${listsBase()}/${listId}?page=${page}&page_size=100&${q()}`);
      const data = Array.isArray(r?.data) ? r.data : [];
      items.push(...data);
      if (typeof r?.meta?.max === "number") max = r.meta.max;
      const total = Number(r?.meta?.total ?? r?.total ?? data.length);
      if (data.length === 0 || items.length >= total || !r?.meta?.next_page) break;
    }

    return { items, max };
  }

  async function createList(title) {
    const r = await api("POST", listsBase(), { title });
    const created = r?.data?.[0] || r;
    if (created?.list_id) return created.list_id;

    const lists = await fetchLists();
    return lists.find(l => (l.title || "").trim() === title)?.list_id || null;
  }

  /** Sucht die Serien-ID zu einem Titel. */
  async function resolveTitle(title) {
    const wanted = normalizeTitle(title);

    for (const [id, t] of seriesTitles) {
      if (normalizeTitle(t) === wanted) return { id, title: t };
    }

    const r = await api(
      "GET",
      `/content/v2/discover/search?q=${encodeURIComponent(title)}&n=12&type=series,movie_listing&${q()}`
    );

    const candidates = (Array.isArray(r?.data) ? r.data : []).flatMap(b => (Array.isArray(b.items) ? b.items : []));
    const exact = candidates.find(c => normalizeTitle(c.title) === wanted);
    return exact ? { id: exact.id, title: exact.title } : null;
  }

  function episodeLabel(panel) {
    const m = panel?.episode_metadata;
    if (!m) return panel?.title || "";
    const season = m.season_display_number || m.season_number;
    const ep = m.episode || m.episode_number;
    if (season && ep) return `S${season} E${ep}`;
    return ep ? `E${ep}` : panel.title || "";
  }

  /**
   * Prüft für gesehene Serien, ob seit dem Markieren Neues erschienen ist.
   * - up_next liefert die nächste Folge aus Sicht des Kontos: ist sie nicht
   *   fertig geschaut und nach dem Markieren erschienen → "neu".
   * - availability_notes enthält Ankündigungen wie "Neue Staffel ab 08.10".
   */
  async function checkSeen(seen, previousInfo) {
    const now = Date.now();
    const info = {};

    const due = Object.entries(seen)
      .filter(([id, v]) => {
        const prev = previousInfo?.[id];
        return !prev || !prev.checkedAt || now - prev.checkedAt > SEEN_RECHECK_MS || prev.checkedAt < v.markedAt;
      })
      .sort((a, b) => (previousInfo?.[a[0]]?.checkedAt || 0) - (previousInfo?.[b[0]]?.checkedAt || 0))
      .slice(0, SEEN_CHECKS_PER_SYNC);

    if (due.length === 0) return info;

    // Ankündigungen gesammelt in einem Aufruf
    const notes = new Map();
    try {
      const r = await api("GET", `/content/v2/cms/objects/${due.map(([id]) => id).join(",")}?${q()}`);
      for (const o of Array.isArray(r?.data) ? r.data : []) {
        const n = o.series_metadata?.availability_notes || o.movie_listing_metadata?.availability_notes || "";
        notes.set(o.id, n.trim());
      }
    } catch (error) {
      if (error instanceof NoTokenError) throw error;
    }

    for (const [id, v] of due) {
      let hasNew = false;
      let next = "";
      try {
        const r = await api("GET", `/content/v2/discover/up_next/${id}?${q()}`);
        const d = Array.isArray(r?.data) ? r.data[0] : null;
        if (d?.panel) {
          const released = publishedAt(d.panel);
          hasNew = d.fully_watched !== true && released > v.markedAt + NEW_MARGIN_MS;
          if (hasNew) next = episodeLabel(d.panel);
        }
      } catch (error) {
        if (error instanceof NoTokenError) throw error;
        // 404 = keine Folgen → nichts Neues
      }

      if (!hasNew && (seriesLastPublic.get(id) || 0) > v.markedAt + NEW_MARGIN_MS) hasNew = true;

      info[id] = { hasNew, next, notes: notes.get(id) || "", checkedAt: now };
    }

    return info;
  }

  /**
   * Ein Sync-Durchlauf:
   * 1. Crunchylisten lesen (= Stand aus allen Geräten)
   * 2. Ausstehende lokale Änderungen anwenden
   * 3. Gesehene Serien auf Neues prüfen
   * 4. Ergebnis an content.js zurückgeben
   */
  async function runSync(pending, previousInfo) {
    const allLists = await fetchLists();

    const remote = { blocked: new Map(), seen: new Map() }; // id -> { title, listId, entryId, markedAt }
    const lists = { blocked: [], seen: [] };

    const ours = allLists
      .map(l => ({ list: l, family: listFamily(l) }))
      .filter(x => x.family)
      .sort((a, b) => (a.list.title || "").localeCompare(b.list.title || ""));

    for (const { list, family } of ours) {
      const { items, max } = await fetchListItems(list.list_id);
      for (const entry of items) {
        const panel = entry.panel && typeof entry.panel === "object" ? entry.panel : null;
        const id = panel?.id || entry.content_id || entry.id;
        if (!id) continue;
        remote[family].set(id, {
          title: panel?.title || entry.title || seriesTitles.get(id) || id,
          listId: list.list_id,
          entryId: entry.id || id,
          markedAt: toMs(entry.modified_at) || Date.now()
        });
        if (panel?.last_public) seriesLastPublic.set(id, toMs(panel.last_public));
      }
      lists[family].push({ listId: list.list_id, count: items.length, max });
    }

    let privateListCount = allLists.length;

    async function listWithSpace(family) {
      const free = lists[family].find(l => l.count < l.max);
      if (free) return free;

      if (privateListCount >= MAX_PRIVATE_LISTS) {
        throw new Error("Keine freie Crunchyliste mehr (Crunchyroll erlaubt maximal 10 Listen).");
      }

      const n = lists[family].length;
      const title = n === 0 ? LIST_TITLES[family] : `${LIST_TITLES[family]} ${n + 1}`;
      const listId = await createList(title);
      if (!listId) throw new Error(`Crunchyliste „${title}“ konnte nicht angelegt werden.`);

      privateListCount++;
      const created = { listId, count: 0, max: DEFAULT_LIST_MAX };
      lists[family].push(created);
      return created;
    }

    async function addTo(family, id, title) {
      const target = await listWithSpace(family);
      await api("POST", `${listsBase()}/${target.listId}`, { content_id: id });
      target.count++;
      remote[family].set(id, { title: title || id, listId: target.listId, entryId: id, markedAt: Date.now() });
    }

    async function removeFrom(family, id) {
      const hit = remote[family].get(id);
      if (!hit) return;
      await api("DELETE", `${listsBase()}/${hit.listId}/${hit.entryId}`);
      remote[family].delete(id);
      const l = lists[family].find(x => x.listId === hit.listId);
      if (l) l.count--;
    }

    const applied = [];
    const unresolved = [];
    const errors = [];

    for (const original of pending || []) {
      let op = original;
      const family = op.list === "seen" ? "seen" : "blocked";
      try {
        if (op.op === "addTitle") {
          const hit = await resolveTitle(op.title);
          if (!hit) {
            unresolved.push({ opId: op.opId, title: op.title, list: family });
            continue;
          }
          op = { ...op, op: "add", id: hit.id, title: hit.title };
          // Eine Serie steht nur in einer Kategorie
          const other = family === "seen" ? "blocked" : "seen";
          await removeFrom(other, hit.id);
        }

        if (op.op === "add") {
          if (!remote[family].has(op.id)) await addTo(family, op.id, op.title);
        } else if (op.op === "readd") {
          // Neu markieren = Datum erneuern
          await removeFrom(family, op.id);
          await addTo(family, op.id, op.title);
        } else if (op.op === "remove") {
          await removeFrom(family, op.id);
        }
        applied.push(op.opId);
      } catch (error) {
        if (error instanceof NoTokenError) throw error;
        errors.push(`${op.title || op.id}: ${error.message}`);
      }
    }

    const out = { blocked: {}, seen: {} };
    for (const [id, v] of remote.blocked) out.blocked[id] = { title: v.title };
    for (const [id, v] of remote.seen) out.seen[id] = { title: v.title, markedAt: v.markedAt };

    let seenInfo = {};
    try {
      seenInfo = await checkSeen(out.seen, previousInfo);
    } catch (error) {
      if (error instanceof NoTokenError) throw error;
      errors.push(`Prüfung auf neue Folgen: ${error.message}`);
    }

    return { remote: out, applied, unresolved, errors, seenInfo };
  }

  // --- Sync-Steuerung ---------------------------------------------------------

  let syncTimer = null;
  let syncRunning = false;
  let waitingForToken = false;
  let initialSyncDone = false;

  function scheduleSync(delay = 1500, force = false) {
    if (force) initialSyncDone = false;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      doSync().catch(error => console.warn(LOG, error));
    }, delay);
  }

  async function doSync() {
    if (syncRunning) return;

    if (!tokenValid() || !accountId) {
      waitingForToken = true;
      return;
    }

    syncRunning = true;
    waitingForToken = false;

    try {
      const go = await askContent({ t: "syncRequest", owner: OWNER });
      if (!go || go.t !== "syncGo") {
        if (go?.t === "syncBusy") scheduleSync(20_000);
        return;
      }

      const result = await runSync(go.pending, go.seenInfo || {});
      initialSyncDone = true;
      toContent({ t: "syncDone", ...result });
    } catch (error) {
      if (error instanceof NoTokenError) {
        waitingForToken = true;
        toContent({ t: "syncFailed", error: "Warte auf Crunchyroll-Anmeldung (Token abgelaufen) – wird automatisch fortgesetzt." });
      } else {
        console.warn(LOG, "Sync fehlgeschlagen:", error);
        toContent({ t: "syncFailed", error: error.message || String(error) });
      }
    } finally {
      syncRunning = false;
    }
  }

  setInterval(() => {
    if (document.visibilityState === "visible") scheduleSync(0, true);
  }, PERIODIC_SYNC_MS);

  // ---------------------------------------------------------------------------
  // Karten auf der Seite
  // ---------------------------------------------------------------------------

  // Reihenfolge = Vorrang. Nur Wurzel-Elemente von Karten (Klassen mit "--"
  // sind bei Crunchyroll die Wurzel, "__" sind innere Teile wie Links).
  const CARD_SELECTORS = [
    '[data-t="watch-list-card"]',
    '[data-t="search-series-card"]',
    '[class*="feed-banner--" i]',
    '[class*="search-show-card--" i]',
    '[data-t="carousel-card-wrapper"]',
    '[role="group"][aria-roledescription="Slide"]',
    '[class*="carousel-scroller__card" i]',
    '[class*="collection-item" i]',
    '[class*="browse-card--" i]',
    '[data-t="episode-card"]',
    '[class*="playable-card--" i]',
    "article"
  ];

  // Hover-Einblendungen (seit 10/2026 bei "Schau weiter"): enthalten einen
  // eigenen, absolut positionierten Link über der ganzen Karte. Den dürfen wir
  // weder als Karte behandeln noch verändern – sonst ist die Karte nicht mehr
  // anklickbar.
  const HOVER_SELECTOR = '[data-t="hover-component"], [class*="hover-info" i], [class*="-hover--" i]';

  function infoFromHref(href) {
    const series = href.match(/\/series\/(G[A-Z0-9]+)/i);
    if (series) return { id: series[1], title: seriesTitles.get(series[1]), episodeId: null };

    const watch = href.match(/\/watch\/(G[A-Z0-9]+)/i);
    if (watch) {
      const s = episodeToSeries.get(watch[1]);
      if (s) return { id: s.id, title: s.title || seriesTitles.get(s.id), episodeId: watch[1] };
    }
    return null;
  }

  function findCard(link) {
    const watchlistCard = link.closest('[data-t="watch-list-card"], [class*="watchlist-card--" i]');
    if (watchlistCard) return watchlistCard.closest(".collection-item") || watchlistCard;

    for (const selector of CARD_SELECTORS) {
      let card = link.closest(selector);
      // Links selbst sind nie die Karte (Buttons in <a> und Positionsänderungen
      // an Links machen Karten unklickbar).
      while (card && card.tagName === "A") card = card.parentElement?.closest(selector) || null;
      if (card) return card;
    }
    return null;
  }

  function onDetailPage() {
    // Auf Serien- und Player-Seiten nichts verstecken und keine Buttons:
    // Wer eine Serie gezielt öffnet, will ihre Folgen sehen.
    return /\/(series|watch)\//.test(location.pathname);
  }

  function onSearchPage() {
    // In der Suche nichts verstecken – dort sucht man gezielt, auch nach
    // markierten Serien. Stattdessen zeigt ein Badge die Kategorie.
    return /\/search\b/.test(location.pathname);
  }

  /** Status einer Karte: "blocked", "seen", "seenNew" oder null */
  function cardStatus(info) {
    if (blockedIds.has(info.id)) return "blocked";
    if (info.title && blockedTitles.has(normalizeTitle(info.title))) return "blocked";
    if (!seenMarked.has(info.id)) return null;

    const markedAt = seenMarked.get(info.id);
    const epDate = info.episodeId ? episodeDates.get(info.episodeId) || 0 : 0;
    if (seenNew.has(info.id) || epDate > markedAt + NEW_MARGIN_MS || (seriesLastPublic.get(info.id) || 0) > markedAt + NEW_MARGIN_MS) {
      return "seenNew";
    }
    return "seen";
  }

  function setCategoryFromCard(info, list, card) {
    const title = info.title || seriesTitles.get(info.id) || info.id;
    if (list === "blocked") {
      blockedIds.add(info.id);
      seenMarked.delete(info.id);
    } else {
      seenMarked.set(info.id, Date.now());
      seenNew.delete(info.id);
      blockedIds.delete(info.id);
    }
    card.classList.add("crlf-hidden");
    toContent({ t: "setCategory", id: info.id, title, list });
  }

  function makeButton(label, tooltip, onClick, extraClass = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `crlf-btn ${extraClass}`.trim();
    button.textContent = label;
    button.title = tooltip;
    button.addEventListener(
      "click",
      event => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      },
      true
    );
    return button;
  }

  function decorate(card, info, status) {
    const key = `${info.id}|${status || ""}`;
    if (card.dataset.crlfKey === key && card.querySelector(":scope > .crlf-actions")) return;

    card.querySelector(":scope > .crlf-actions")?.remove();
    card.querySelector(":scope > .crlf-badge")?.remove();
    card.dataset.crlfKey = key;
    card.classList.add("crlf-card");
    // Nur statisch positionierte Karten relativ machen – vorhandene
    // absolute/fixed-Positionierung von Crunchyroll bleibt unangetastet.
    if (getComputedStyle(card).position === "static") card.classList.add("crlf-pos");

    const name = info.title || info.id;
    const bar = document.createElement("div");
    bar.className = "crlf-actions";

    bar.append(
      makeButton(
        status === "seenNew" ? "✓ Wieder gesehen" : "✓ Gesehen",
        status === "seenNew"
          ? `„${name}“ ist wieder auf dem aktuellen Stand – ausblenden bis zur nächsten neuen Folge`
          : `„${name}“ als gesehen markieren – taucht wieder auf, sobald neue Folgen erscheinen`,
        () => setCategoryFromCard(info, "seen", card),
        "crlf-btn-seen"
      ),
      makeButton("✕", `„${name}“ als uninteressant dauerhaft ausblenden`, () => setCategoryFromCard(info, "blocked", card), "crlf-btn-block")
    );
    card.appendChild(bar);

    const badges = {
      seenNew: ["✨ Neu", "Als gesehen markiert – seitdem sind neue Folgen erschienen", ""],
      seen: ["✓ Gesehen", "Als gesehen markiert – ausgeblendet bis zur nächsten neuen Folge", "crlf-badge-muted"],
      blocked: ["✕ Uninteressant", "Als uninteressant ausgeblendet", "crlf-badge-muted"]
    };
    if (badges[status]) {
      const [text, tooltip, cls] = badges[status];
      const badge = document.createElement("span");
      badge.className = `crlf-badge ${cls}`.trim();
      badge.textContent = text;
      badge.title = tooltip;
      card.appendChild(badge);
    }
  }

  function undecorate(card) {
    card.querySelector(":scope > .crlf-actions")?.remove();
    card.querySelector(":scope > .crlf-badge")?.remove();
    delete card.dataset.crlfKey;
  }

  function scan() {
    const detail = onDetailPage();
    const search = onSearchPage();
    const showButtons = state.settings?.showButtons !== false && !detail;

    const links = document.querySelectorAll('a[href*="/series/"], a[href*="/watch/"]');
    const handled = new Set();
    const hideNow = new Set();

    for (const link of links) {
      if (link.closest("header, nav, footer, [class*='hero' i]")) continue;
      if (link.closest(HOVER_SELECTOR)) continue;

      const card = findCard(link);
      if (!card || handled.has(card)) continue;

      const info = infoFromHref(link.getAttribute("href") || "");
      if (!info) continue;
      handled.add(card);

      const status = cardStatus(info);
      if (!detail && !search && (status === "blocked" || status === "seen")) {
        hideNow.add(card);
        continue;
      }

      if (showButtons) decorate(card, info, status);
      else undecorate(card);
    }

    for (const hidden of document.querySelectorAll(".crlf-hidden")) {
      if (!hideNow.has(hidden)) hidden.classList.remove("crlf-hidden");
    }
    for (const card of hideNow) card.classList.add("crlf-hidden");
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      try {
        scan();
      } catch (error) {
        console.warn(LOG, "Scan fehlgeschlagen:", error);
      }
    }, 250);
  }

  function startObserver() {
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && !n.closest?.(".crlf-actions, .crlf-badge")) {
            scheduleScan();
            return;
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scheduleScan();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  } else {
    startObserver();
  }

  toContent({ t: "ready" });
})();
