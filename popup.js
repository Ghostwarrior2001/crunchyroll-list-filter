/*
 * Popup – verwaltet Einstellungen und die beiden Listen.
 * Schreibt nur in chrome.storage.local; content.js/page.js übertragen die
 * Änderungen in die Crunchylisten, sobald ein Crunchyroll-Tab offen ist.
 */

const $ = selector => document.querySelector(selector);

const els = {
  syncText: $("#syncText"),
  syncStatus: $("#syncStatus"),
  syncNow: $("#syncNow"),
  hideCompleted: $("#hideCompleted"),
  showButtons: $("#showButtons"),
  tabs: [...document.querySelectorAll(".tab")],
  tabHint: $("#tabHint"),
  newTitle: $("#newTitle"),
  addTitle: $("#addTitle"),
  addHint: $("#addHint"),
  filter: $("#filter"),
  list: $("#entryList"),
  exportSettings: $("#exportSettings"),
  importSettings: $("#importSettings"),
  settingsJson: $("#settingsJson")
};

const TAB_HINTS = {
  seen: "Ausgeblendet, bis Crunchyroll nach dem Markieren neue Folgen veröffentlicht – dann tauchen sie mit „✨ Neu“ wieder auf.",
  blocked: "Dauerhaft ausgeblendet, egal ob neue Folgen erscheinen."
};

let state = CRLF.withDefaults(null);
let currentList = readTab();

function readTab() {
  try {
    return localStorage.getItem("crlf-tab") === "blocked" ? "blocked" : "seen";
  } catch {
    return "seen";
  }
}

function writeTab(list) {
  try {
    localStorage.setItem("crlf-tab", list);
  } catch {
    /* egal */
  }
}

function formatTime(ts) {
  if (!ts) return "noch nie";
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatDate(ts) {
  return ts ? new Date(ts).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "";
}

function renderSync() {
  const pending = state.pending.length;
  let text;
  let cls = "ok";

  if (state.sync.lastError) {
    text = `⚠ ${state.sync.lastError}`;
    cls = "error";
  } else if (pending > 0) {
    text = `${pending} Änderung${pending === 1 ? "" : "en"} ausstehend – wird beim nächsten Crunchyroll-Tab übertragen`;
    cls = "pending";
  } else {
    text = `✓ Synchronisiert · ${formatTime(state.sync.lastSync)}`;
  }

  els.syncText.textContent = text;
  els.syncStatus.className = `sync-status ${cls}`;
}

/** Sortierung bei "Gesehen": Neues zuerst, dann Angekündigtes, dann alphabetisch. */
function seenRank(entry) {
  if (entry.info?.hasNew) return 0;
  if (entry.info?.notes) return 1;
  return 2;
}

function describe(entry) {
  if (entry.kind === "titleOnly") {
    return { text: "nur lokal – keine Serien-ID gefunden", cls: "muted" };
  }
  if (entry.kind === "pendingTitle") {
    return { text: "ausstehend – Serie wird beim Sync gesucht", cls: "pending" };
  }

  const parts = [];
  let cls = "muted";

  if (entry.list === "seen") {
    if (entry.info?.hasNew) {
      parts.push(`✨ Neu${entry.info.next ? `: ${entry.info.next}` : ""}`);
      cls = "new";
    } else if (entry.info?.notes) {
      parts.push(`📅 ${entry.info.notes}`);
      cls = "announced";
    }
    if (entry.markedAt) parts.push(`gesehen ${formatDate(entry.markedAt)}`);
  }

  if (entry.status === "pending") {
    parts.push("ausstehend");
    if (cls === "muted") cls = "pending";
  }

  return parts.length ? { text: parts.join(" · "), cls } : null;
}

function renderTabs() {
  for (const tab of els.tabs) {
    const list = tab.dataset.list;
    tab.classList.toggle("active", list === currentList);
    tab.setAttribute("aria-selected", String(list === currentList));
    const count = CRLF.effectiveEntries(state, list).length;
    const newCount = list === "seen" ? CRLF.effectiveEntries(state, "seen").filter(e => e.info?.hasNew).length : 0;
    tab.querySelector("[data-count]").textContent = `${count}${newCount ? ` · ✨${newCount}` : ""}`;
  }
  els.tabHint.textContent = TAB_HINTS[currentList];
}

function renderList() {
  let entries = CRLF.effectiveEntries(state, currentList);
  if (currentList === "seen") {
    entries = [...entries].sort((a, b) => seenRank(a) - seenRank(b) || a.title.localeCompare(b.title, "de"));
  }

  const query = CRLF.normalizeTitle(els.filter.value);
  const visible = query ? entries.filter(e => CRLF.normalizeTitle(e.title).includes(query)) : entries;

  els.list.replaceChildren();

  if (visible.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = entries.length
      ? "Keine Treffer."
      : currentList === "seen"
        ? "Noch nichts als gesehen markiert. Tipp: „✓ Gesehen“ auf einer Karte."
        : "Noch keine Serien ausgeblendet.";
    els.list.appendChild(li);
    return;
  }

  const other = currentList === "seen" ? "blocked" : "seen";

  for (const entry of visible) {
    const li = document.createElement("li");

    const text = document.createElement("div");
    text.className = "entry-text";

    const name = document.createElement("span");
    name.className = "title";
    name.textContent = entry.title;
    text.appendChild(name);

    const desc = describe(entry);
    if (desc) {
      const sub = document.createElement("span");
      sub.className = `sub ${desc.cls}`;
      sub.textContent = desc.text;
      text.appendChild(sub);
    }

    const actions = document.createElement("div");
    actions.className = "entry-actions";

    if (entry.kind === "id") {
      if (entry.list === "seen" && entry.info?.hasNew) {
        actions.appendChild(
          button("✓", "Wieder auf dem aktuellen Stand – Datum erneuern", async () => {
            state = await CRLF.update(s => CRLF.setCategory(s, entry.id, entry.title, "seen"));
            render();
            requestSync();
          })
        );
      }

      actions.appendChild(
        button(
          other === "blocked" ? "→ ✕" : "→ ✓",
          other === "blocked" ? "Nach „Uninteressant“ verschieben" : "Nach „Gesehen“ verschieben",
          async () => {
            state = await CRLF.update(s => CRLF.setCategory(s, entry.id, entry.title, other));
            render();
            requestSync();
          }
        )
      );
    }

    actions.appendChild(
      button("Entfernen", `„${entry.title}“ wieder normal anzeigen`, async () => {
        state = await CRLF.update(s => CRLF.unblock(s, entry));
        render();
        requestSync();
      }, "remove")
    );

    li.append(text, actions);
    els.list.appendChild(li);
  }
}

function button(label, title, onClick, cls = "small") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function render() {
  els.hideCompleted.checked = state.settings.hideCompleted !== false;
  els.showButtons.checked = state.settings.showButtons !== false;
  renderSync();
  renderTabs();
  renderList();
}

async function requestSync() {
  const tabs = await chrome.tabs.query({ url: "https://www.crunchyroll.com/*" }).catch(() => []);
  if (!tabs.length) return false;

  const active = tabs.find(t => t.active) || tabs[0];
  try {
    await chrome.tabs.sendMessage(active.id, { type: "CRLF_SYNC_NOW" });
    return true;
  } catch {
    return false;
  }
}

async function addTitle() {
  const title = els.newTitle.value.trim();
  if (!title) return;

  let added = false;
  state = await CRLF.update(s => {
    added = CRLF.addByTitle(s, title, currentList);
  });

  els.addHint.textContent = added
    ? `„${title}“ → ${CRLF.LIST_LABEL[currentList]}. Wird beim nächsten Sync der Serie zugeordnet.`
    : `„${title}“ sieht nicht wie ein Serientitel aus und wurde nicht übernommen.`;

  if (added) els.newTitle.value = "";
  render();
  requestSync();
}

function exportState() {
  const pack = list =>
    CRLF.effectiveEntries(state, list).map(e => (e.id ? { id: e.id, title: e.title } : { title: e.title }));

  const data = {
    format: "crunchyroll-list-filter",
    version: 4,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    series: pack("blocked"),
    seen: pack("seen")
  };
  els.settingsJson.value = JSON.stringify(data, null, 2);
  els.settingsJson.select();
}

async function importState() {
  let data;
  try {
    data = JSON.parse(els.settingsJson.value.trim());
  } catch (error) {
    els.settingsJson.value = `Import fehlgeschlagen: kein gültiges JSON.\n${error.message}`;
    return;
  }

  // v3/v4: series = Uninteressant, seen = Gesehen; v0.1.x: blockedTitles
  const groups = [
    ["blocked", Array.isArray(data?.series) ? data.series : []],
    ["seen", Array.isArray(data?.seen) ? data.seen : []]
  ];
  const legacyTitles = Array.isArray(data?.blockedTitles) ? data.blockedTitles : [];

  if (!groups.some(([, g]) => g.length) && !legacyTitles.length) {
    els.settingsJson.value = "Import fehlgeschlagen: keine Serien gefunden.";
    return;
  }

  let count = 0;
  state = await CRLF.update(s => {
    for (const [list, entries] of groups) {
      for (const entry of entries) {
        if (entry?.id && !CRLF.isIn(s, list, entry.id)) {
          CRLF.setCategory(s, entry.id, entry.title, list);
          count++;
        } else if (!entry?.id && entry?.title && CRLF.addByTitle(s, entry.title, list)) {
          count++;
        }
      }
    }
    for (const raw of legacyTitles) {
      const title = CRLF.cleanLegacyTitle(raw);
      if (title && CRLF.addByTitle(s, title, "blocked")) count++;
    }
    if (data.settings && typeof data.settings === "object") {
      s.settings = { ...s.settings, ...data.settings };
    }
  });

  els.settingsJson.value = `Import erfolgreich: ${count} Einträge übernommen.`;
  render();
  requestSync();
}

for (const tab of els.tabs) {
  tab.addEventListener("click", () => {
    currentList = tab.dataset.list;
    writeTab(currentList);
    els.addHint.textContent = "";
    render();
  });
}

els.hideCompleted.addEventListener("change", async () => {
  state = await CRLF.update(s => {
    s.settings.hideCompleted = els.hideCompleted.checked;
  });
  els.addHint.textContent = "Wirkt nach dem Neuladen der Crunchyroll-Seite.";
});

els.showButtons.addEventListener("change", async () => {
  state = await CRLF.update(s => {
    s.settings.showButtons = els.showButtons.checked;
  });
});

els.syncNow.addEventListener("click", async () => {
  const ok = await requestSync();
  els.syncText.textContent = ok ? "Synchronisiere …" : "Öffne crunchyroll.com, um zu synchronisieren.";
  if (!ok) els.syncStatus.className = "sync-status pending";
});

els.addTitle.addEventListener("click", addTitle);
els.newTitle.addEventListener("keydown", event => {
  if (event.key === "Enter") addTitle();
});
els.filter.addEventListener("input", renderList);
els.exportSettings.addEventListener("click", exportState);
els.importSettings.addEventListener("click", importState);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[CRLF.STORAGE_KEY]) {
    state = CRLF.withDefaults(changes[CRLF.STORAGE_KEY].newValue);
    render();
  }
});

CRLF.load()
  .then(s => {
    state = s;
    render();
    requestSync();
  })
  .catch(error => {
    els.syncText.textContent = `Fehler: ${error.message}`;
  });
