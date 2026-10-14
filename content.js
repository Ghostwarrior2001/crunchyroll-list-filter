/*
 * Crunchyroll Listenfilter – Brücke zwischen Erweiterungsspeicher und Seite
 *
 * Läuft in der isolierten Welt der Erweiterung. Aufgaben:
 * - Zustand aus chrome.storage.local laden und an page.js weitergeben
 * - Alte Blocklisten (v0.1.x) einmalig bereinigen und übernehmen
 * - Befehle von page.js (Ausblenden-Button, Sync-Ergebnisse) speichern
 * - Befehle aus dem Popup (Jetzt synchronisieren) an page.js weiterleiten
 *
 * Die eigentliche Filterung und der Crunchylisten-Sync laufen in page.js,
 * weil nur dort die API-Antworten und das Zugriffstoken der Seite verfügbar sind.
 */

(() => {
  const PAGE_CACHE_KEY = "CRLF_PAGE_STATE_V3";
  const LEGACY_BACKUP_KEY = "CRLF_SETTINGS_BACKUP_V1";
  const SYNC_LOCK_MS = 60_000;

  function toPage(message) {
    window.postMessage({ crlf: "toPage", ...message }, location.origin);
  }

  function writePageCache(state) {
    try {
      window.localStorage.setItem(PAGE_CACHE_KEY, JSON.stringify(CRLF.pageState(state)));
    } catch {
      /* localStorage kann blockiert sein – dann eben nur per Nachricht */
    }
  }

  async function pushState() {
    const state = await CRLF.load();
    writePageCache(state);
    toPage({ t: "state", state: CRLF.pageState(state) });
  }

  /**
   * Übernimmt einmalig die Blockliste aus v0.1.x:
   * - chrome.storage.local.blockedTitles
   * - Backup im Crunchyroll-localStorage
   * Kaputte Einträge ("23min verbleibend") werden verworfen, Einträge wie
   * "Jetzt anschauen Episode 1 von X" auf "X" gekürzt. Alles Übrige wird als
   * "addTitle" eingereiht; page.js sucht beim Sync die passende Serien-ID.
   */
  async function migrateLegacy() {
    const state = await CRLF.load();
    if (state.migratedV3) return;

    const old = await chrome.storage.local.get([
      "blockedTitles",
      "removedTitleKeys",
      "hideCompletedWatchlistItems",
      "showHideButtons"
    ]);

    let backup = {};
    try {
      backup = JSON.parse(window.localStorage.getItem(LEGACY_BACKUP_KEY) || "{}") || {};
    } catch {
      backup = {};
    }

    const removed = new Set(
      [...(old.removedTitleKeys || []), ...(backup.removedTitleKeys || [])].map(CRLF.normalizeTitle)
    );

    const rawTitles = Array.isArray(old.blockedTitles) ? old.blockedTitles : backup.blockedTitles || [];
    const seen = new Set();

    for (const raw of rawTitles) {
      const title = CRLF.cleanLegacyTitle(raw);
      const n = CRLF.normalizeTitle(title);
      if (!title || seen.has(n) || removed.has(CRLF.normalizeTitle(raw))) continue;
      seen.add(n);
      CRLF.blockTitle(state, title);
    }

    if (typeof old.hideCompletedWatchlistItems === "boolean") {
      state.settings.hideCompleted = old.hideCompletedWatchlistItems;
    }
    if (typeof old.showHideButtons === "boolean") {
      state.settings.showButtons = old.showHideButtons;
    }

    state.migratedV3 = true;
    await CRLF.save(state);

    await chrome.storage.local.remove([
      "blockedTitles",
      "removedTitleKeys",
      "schemaVersion",
      "hideCompletedWatchlistItems",
      "showHideButtons"
    ]);

    try {
      window.localStorage.removeItem(LEGACY_BACKUP_KEY);
    } catch {
      /* egal */
    }
  }

  /** Nachrichten von page.js */
  async function handlePageMessage(msg) {
    switch (msg.t) {
      case "ready":
        await pushState();
        break;

      case "block":
        await CRLF.update(state => CRLF.setCategory(state, msg.id, msg.title, "blocked"));
        break;

      case "setCategory":
        await CRLF.update(state => CRLF.setCategory(state, msg.id, msg.title, msg.list === "seen" ? "seen" : "blocked"));
        break;

      case "syncRequest": {
        // Einfache Sperre, damit zwei offene Crunchyroll-Tabs nicht parallel
        // dieselben Änderungen in die Crunchyliste schreiben.
        const state = await CRLF.load();
        const now = Date.now();
        if (state.sync.lockUntil > now && state.sync.lockOwner !== msg.owner) {
          toPage({ t: "syncBusy", requestId: msg.requestId });
          break;
        }
        state.sync.lockUntil = now + SYNC_LOCK_MS;
        state.sync.lockOwner = msg.owner;
        await CRLF.save(state);
        toPage({
          t: "syncGo",
          requestId: msg.requestId,
          pending: state.pending,
          seenInfo: state.seenInfo
        });
        break;
      }

      case "syncDone":
        await CRLF.update(state => {
          const applied = new Set(msg.applied || []);
          const unresolved = new Map((msg.unresolved || []).map(u => [u.opId, u]));

          state.pending = state.pending.filter(o => !applied.has(o.opId) && !unresolved.has(o.opId));

          // Nicht gefundene Titel: "Uninteressant" filtert lokal per Titel weiter,
          // bei "Gesehen" geht das nicht sinnvoll (kein Datum) – dort nur Hinweis.
          const notFound = [];
          for (const u of unresolved.values()) {
            if (u.list === "seen") {
              notFound.push(u.title);
              continue;
            }
            const n = CRLF.normalizeTitle(u.title);
            if (!state.titleOnly.some(t => CRLF.normalizeTitle(t) === n)) state.titleOnly.push(u.title);
          }
          if (notFound.length) {
            msg.errors = [...(msg.errors || []), `Serie nicht gefunden: ${notFound.join(", ")}`];
          }

          const remote = msg.remote || {};
          state.blocked = remote.blocked || {};
          state.seen = remote.seen || {};

          // Titel-Einträge, die inzwischen per ID abgedeckt sind, aufräumen.
          const remoteTitles = new Set(
            [...Object.values(state.blocked), ...Object.values(state.seen)].map(v => CRLF.normalizeTitle(v.title))
          );
          state.titleOnly = state.titleOnly.filter(t => !remoteTitles.has(CRLF.normalizeTitle(t)));

          // Prüfergebnisse für "Gesehen" übernehmen, verwaiste entfernen.
          const info = { ...state.seenInfo, ...(msg.seenInfo || {}) };
          state.seenInfo = Object.fromEntries(Object.entries(info).filter(([id]) => state.seen[id]));

          state.sync.lastSync = Date.now();
          state.sync.lastError = msg.errors?.length ? msg.errors.join("\n") : null;
          state.sync.lockUntil = 0;
        });
        break;

      case "syncFailed":
        await CRLF.update(state => {
          state.sync.lastError = msg.error || "Unbekannter Fehler";
          state.sync.lockUntil = 0;
        });
        break;

      default:
        break;
    }
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.crlf !== "toContent") return;
    handlePageMessage(msg).catch(error => console.warn("[Crunchyroll Listenfilter]", error));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[CRLF.STORAGE_KEY]) {
      pushState().catch(() => {});
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "CRLF_SYNC_NOW") {
      toPage({ t: "syncNow" });
      sendResponse({ ok: true });
    }
    return false;
  });

  migrateLegacy()
    .catch(error => console.warn("[Crunchyroll Listenfilter] Migration fehlgeschlagen:", error))
    .finally(() => pushState().catch(() => {}));
})();
