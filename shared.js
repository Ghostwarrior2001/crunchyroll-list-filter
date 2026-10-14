/*
 * Crunchyroll Listenfilter – gemeinsame Logik für content.js und popup.js
 *
 * Zwei Kategorien:
 *   blocked  "Uninteressant" – Serie wird überall dauerhaft ausgeblendet.
 *   seen     "Gesehen"       – Serie wird ausgeblendet, bis Crunchyroll nach
 *                              dem Markieren neue Folgen/Staffeln veröffentlicht.
 *
 * Datenmodell (chrome.storage.local, Schlüssel "crlf"):
 *
 *   blocked   { [serienId]: { title } }
 *   seen      { [serienId]: { title, markedAt } }     markedAt = ms seit 1970
 *             Beide sind Spiegel der Crunchylisten im Konto.
 *   seenInfo  { [serienId]: { hasNew, next, notes, checkedAt } }
 *             Ergebnis der Prüfung "gibt es Neues?" (für Popup und Filter).
 *   pending   [{ opId, list, op: "add"|"remove"|"readd"|"addTitle", id?, title, ts }]
 *             Lokale Änderungen, die noch nicht in die Crunchylisten geschrieben
 *             wurden (z. B. weil gerade kein Crunchyroll-Tab offen ist).
 *   titleOnly [ "Titel" ]
 *             Uninteressant-Titel ohne gefundene Serien-ID (nur lokal).
 *   settings  { hideCompleted, showButtons }
 *   sync      { lastSync, lastError, lockUntil }
 */

// eslint-disable-next-line no-unused-vars
const CRLF = (() => {
  const STORAGE_KEY = "crlf";
  const LISTS = ["blocked", "seen"];

  const LIST_LABEL = {
    blocked: "Uninteressant",
    seen: "Gesehen"
  };

  const DEFAULT_STATE = {
    version: 4,
    migratedV3: false,
    settings: {
      hideCompleted: true,
      showButtons: true
    },
    blocked: {},
    seen: {},
    seenInfo: {},
    pending: [],
    titleOnly: [],
    sync: {
      lastSync: null,
      lastError: null,
      lockUntil: 0
    }
  };

  /** Titel vergleichbar machen: Groß/klein, Satzzeichen und Leerraum egal. */
  function normalizeTitle(title) {
    return (title || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[“”„"'’`´]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  /** Laufzeiten, Restzeiten und Badges sind keine Serientitel. */
  function looksLikeMetadata(title) {
    const n = normalizeTitle(title);
    return (
      !n ||
      /^\d{1,3}\s*(min|mins|minute|minuten|minutes|std|h)\b/.test(n) ||
      /\b(verbleibend|remaining|left)$/.test(n) ||
      /^\d{1,2} \d{2}( \d{2})?$/.test(n) ||
      /^(hd|sd|dub|sub|omu|folge|episode|staffel|season|neu|new)$/.test(n)
    );
  }

  /**
   * Bereinigt Titel aus v0.1.x, die aus aria-labels stammen, z. B.
   * "Jetzt anschauen Episode 1 von Oh Boy, Was I Wrong About Her".
   * Liefert "" für reine Metadaten wie "23min verbleibend".
   */
  function cleanLegacyTitle(raw) {
    let t = (raw || "").replace(/\s+/g, " ").trim();
    t = t.replace(
      /^(jetzt anschauen|jetzt ansehen|weiterschauen|weiter schauen|weiter ansehen|erneut anschauen|erneut ansehen|fortsetzen|watch now|continue watching|continue|watch again)\s*:?\s*(episode|folge|ep\.?|e)\s*\d+\s*(von|of)\s+/i,
      ""
    );
    return looksLikeMetadata(t) ? "" : t;
  }

  function obj(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function withDefaults(raw) {
    const s = obj(raw);
    return {
      ...DEFAULT_STATE,
      ...s,
      settings: { ...DEFAULT_STATE.settings, ...obj(s.settings) },
      sync: { ...DEFAULT_STATE.sync, ...obj(s.sync) },
      blocked: obj(s.blocked),
      seen: obj(s.seen),
      seenInfo: obj(s.seenInfo),
      // Ops aus v0.3.0 hatten noch keine Liste – das war immer "blocked".
      pending: (Array.isArray(s.pending) ? s.pending : []).map(o => ({ list: "blocked", ...o })),
      titleOnly: Array.isArray(s.titleOnly) ? s.titleOnly : []
    };
  }

  async function load() {
    const r = await chrome.storage.local.get(STORAGE_KEY);
    return withDefaults(r[STORAGE_KEY]);
  }

  async function save(state) {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  }

  /** Liest, verändert und speichert den Zustand in einem Schritt. */
  async function update(mutator) {
    const state = await load();
    await mutator(state);
    await save(state);
    return state;
  }

  function newOpId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function opKey(o) {
    return `${o.list}|${o.id ? `id:${o.id}` : `t:${normalizeTitle(o.title)}`}`;
  }

  /**
   * Fügt eine Änderung in die Warteschlange ein und fasst gegenläufige
   * Änderungen zusammen (Ausblenden + sofort wieder Einblenden = nichts tun).
   */
  function queueOp(state, op) {
    const key = opKey(op);
    state.pending = state.pending.filter(o => opKey(o) !== key);

    const synced = op.id ? state[op.list][op.id] : null;
    if (op.op === "add" && synced) return;
    if (op.op === "remove" && !synced) return;

    state.pending.push({ opId: newOpId(), ts: Date.now(), ...op });
  }

  /** Ist die Serie (inkl. ausstehender Änderungen) in dieser Liste? */
  function isIn(state, list, id) {
    let present = Boolean(state[list][id]);
    for (const o of state.pending) {
      if (o.list !== list || o.id !== id) continue;
      if (o.op === "add" || o.op === "readd") present = true;
      if (o.op === "remove") present = false;
    }
    return present;
  }

  /**
   * Serie in eine Kategorie legen. Eine Serie steht immer nur in einer
   * Kategorie – aus der anderen wird sie dabei entfernt.
   * Bei "seen" und bereits vorhandener Markierung wird das Datum erneuert
   * ("wieder auf dem aktuellen Stand").
   */
  function setCategory(state, id, title, list) {
    const other = list === "blocked" ? "seen" : "blocked";
    if (isIn(state, other, id)) queueOp(state, { list: other, op: "remove", id, title });

    if (list === "seen" && isIn(state, "seen", id)) {
      queueOp(state, { list, op: "readd", id, title: title || id });
      if (state.seenInfo[id]) state.seenInfo[id] = { ...state.seenInfo[id], hasNew: false, checkedAt: 0 };
      return;
    }

    queueOp(state, { list, op: "add", id, title: title || id });
  }

  /** Kompatibel zu v0.3.0 */
  function blockId(state, id, title) {
    setCategory(state, id, title, "blocked");
  }

  /** Serie per Titel einordnen (ID wird beim nächsten Sync gesucht). */
  function addByTitle(state, title, list = "blocked") {
    const clean = (title || "").trim();
    if (!clean || looksLikeMetadata(clean)) return false;

    const n = normalizeTitle(clean);
    for (const l of LISTS) {
      const known = Object.entries(state[l]).find(([, v]) => normalizeTitle(v.title) === n);
      if (known) {
        setCategory(state, known[0], known[1].title, list);
        return true;
      }
    }

    state.titleOnly = state.titleOnly.filter(t => normalizeTitle(t) !== n);
    queueOp(state, { list, op: "addTitle", title: clean });
    return true;
  }

  /** Kompatibel zu v0.3.0 */
  function blockTitle(state, title) {
    return addByTitle(state, title, "blocked");
  }

  /** Eintrag aus seiner Liste entfernen (egal welcher Art). */
  function unblock(state, entry) {
    if (entry.kind === "titleOnly") {
      const n = normalizeTitle(entry.title);
      state.titleOnly = state.titleOnly.filter(t => normalizeTitle(t) !== n);
      return;
    }

    if (entry.kind === "pendingTitle") {
      state.pending = state.pending.filter(o => o.opId !== entry.opId);
      return;
    }

    queueOp(state, { list: entry.list, op: "remove", id: entry.id, title: entry.title });
  }

  /**
   * Die wirksamen Einträge einer Liste: synchronisierte Einträge plus
   * ausstehende Änderungen (plus lokale Titel-Einträge bei "blocked").
   */
  function effectiveEntries(state, list = "blocked") {
    const byId = new Map();

    for (const [id, v] of Object.entries(state[list])) {
      byId.set(id, {
        kind: "id",
        list,
        id,
        title: v.title || id,
        markedAt: v.markedAt || null,
        status: "synced",
        info: list === "seen" ? state.seenInfo[id] || null : null
      });
    }

    const pendingTitles = [];

    for (const op of state.pending) {
      if (op.list !== list) continue;
      if (op.op === "add" || op.op === "readd") {
        byId.set(op.id, {
          kind: "id",
          list,
          id: op.id,
          title: op.title || op.id,
          markedAt: op.ts,
          status: "pending",
          info: list === "seen" && op.op === "readd" ? { ...(state.seenInfo[op.id] || {}), hasNew: false } : null
        });
      } else if (op.op === "remove") {
        byId.delete(op.id);
      } else if (op.op === "addTitle") {
        pendingTitles.push({ kind: "pendingTitle", list, opId: op.opId, title: op.title, status: "pending" });
      }
    }

    const titleOnly =
      list === "blocked" ? state.titleOnly.map(title => ({ kind: "titleOnly", list, title, status: "local" })) : [];

    return [...byId.values(), ...pendingTitles, ...titleOnly].sort((a, b) =>
      a.title.localeCompare(b.title, "de", { sensitivity: "base" })
    );
  }

  /** Kompakter Zustand für das Seiten-Script (page.js). */
  function pageState(state) {
    const ids = {};
    const titles = [];
    const seen = {};
    const seenNew = [];

    for (const e of effectiveEntries(state, "blocked")) {
      if (e.kind === "id") ids[e.id] = e.title;
      else titles.push(normalizeTitle(e.title));
    }

    for (const e of effectiveEntries(state, "seen")) {
      if (e.kind !== "id") continue;
      seen[e.id] = { title: e.title, markedAt: e.markedAt || Date.now() };
      if (e.info?.hasNew) seenNew.push(e.id);
    }

    return {
      ids,
      titles,
      seen,
      seenNew,
      settings: state.settings,
      pendingCount: state.pending.length
    };
  }

  return {
    STORAGE_KEY,
    LISTS,
    LIST_LABEL,
    DEFAULT_STATE,
    normalizeTitle,
    looksLikeMetadata,
    cleanLegacyTitle,
    withDefaults,
    load,
    save,
    update,
    queueOp,
    isIn,
    setCategory,
    blockId,
    addByTitle,
    blockTitle,
    unblock,
    effectiveEntries,
    pageState
  };
})();
