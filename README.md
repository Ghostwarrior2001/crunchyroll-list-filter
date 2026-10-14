# Crunchyroll Listenfilter

Entpackte Brave/Chrome-Erweiterung für crunchyroll.com.

## Funktionen

- **Zwei Kategorien** – per Button auf jeder Karte oder per Titel im Popup:
  - **✓ Gesehen**: Serie wird ausgeblendet, bis Crunchyroll nach dem Markieren etwas
    Neues veröffentlicht (neue Folge, neue Staffel). Dann taucht sie überall wieder auf und
    trägt auf Karten ein „✨ Neu“. Angekündigte Staffeln („Neue Staffel ab 08.10“) zeigt das
    Popup schon vorher an. Nach dem Nachholen: „✓ Wieder gesehen“.
  - **✕ Uninteressant**: Serie wird dauerhaft ausgeblendet – überall in Listen wie
    „Schau weiter“, Watchlist, Empfehlungen, Neu, Beliebt, Simulcast …
- **Fertig Geschautes ausblenden**: Einträge in „Schau weiter“ und in der Watchlist, die
  Crunchyroll als komplett gesehen markiert („Erneut ansehen“), verschwinden. Sobald eine
  neue Folge erscheint, liefert Crunchyroll die neue Folge und der Eintrag ist wieder da.
- **Keine Lücken**: Gefiltert werden die API-Antworten, bevor Crunchyroll sie darstellt.
  Die Reihen rücken dadurch einfach auf. „Schau weiter“ fordert außerdem ein paar Einträge
  mehr an, damit die Reihe nach dem Filtern voll bleibt.
- **Geräteübergreifend**: Die Listen liegen als private Crunchylisten
  **„Ausgeblendet (Listenfilter)“** (= Uninteressant) und **„Gesehen (Listenfilter)“** in deinem
  Crunchyroll-Konto. Das Markierungsdatum für „Gesehen“ ist das Änderungsdatum des
  Listeneintrags und synchronisiert dadurch mit. Damit gelten sie in Brave,
  Chrome und auf jedem Gerät, auf dem die Erweiterung installiert ist. In der Crunchyroll-App
  siehst du die Listen unter „Crunchylisten“ und kannst dort auch Serien entfernen.
  Bei mehr als 100 Serien legt die Erweiterung automatisch „… 2“, „… 3“ an
  (Crunchyroll erlaubt insgesamt 10 private Listen).

## Installation / Update

1. `brave://extensions/` bzw. `chrome://extensions/` öffnen
2. Entwicklermodus aktivieren
3. „Entpackte Erweiterung laden“ → diesen Ordner wählen
   (bei einem Update: beim vorhandenen Eintrag auf ⟳ klicken)
4. Crunchyroll-Tabs neu laden

## Wie es technisch funktioniert

| Datei        | Aufgabe |
|--------------|---------|
| `page.js`    | Läuft in der Seite selbst (`"world": "MAIN"`). Hängt sich in XHR/fetch, filtert die JSON-Antworten von `/content/v2/discover/…` und `/personalization/…`, merkt sich Episode→Serie-Zuordnungen, setzt die Buttons und spricht die Crunchylisten-API mit dem Token der Seite an. |
| `content.js` | Brücke zu `chrome.storage.local`, übernimmt einmalig die alte Liste, leitet Popup-Befehle weiter. |
| `shared.js`  | Datenmodell, Titelbereinigung, Warteschlange für Änderungen (Popup + content.js). |
| `popup.*`    | Einstellungen, Liste, Export/Import, Sync-Status. |

Serien werden über ihre **Serien-ID** erkannt (z. B. `GRMG8ZQZR`), nicht mehr über Kartentext.
Änderungen, die gemacht werden, während kein Crunchyroll-Tab offen ist, landen in einer
Warteschlange und werden beim nächsten Besuch übertragen.

Verwendete (inoffizielle) Crunchyroll-Endpunkte:

- `GET  /content/v2/{konto}/custom-lists`
- `POST /content/v2/{konto}/custom-lists` `{ "title": … }`
- `GET  /content/v2/{konto}/custom-lists/{liste}`
- `POST /content/v2/{konto}/custom-lists/{liste}` `{ "content_id": … }`
- `DELETE /content/v2/{konto}/custom-lists/{liste}/{eintrag}`
- `GET  /content/v2/discover/search` (nur um alte Titel-Einträge einer ID zuzuordnen)

## Änderungen in v0.3.0

- Filterung auf API-Ebene statt per CSS → keine leeren Plätze mehr in „Schau weiter“.
- „Erledigt“-Erkennung über das API-Feld `fully_watched` statt Textsuche nach „Erneut ansehen“.
- Serien-IDs statt geratener Titel. Fehlerhafte Alt-Einträge wie „23min verbleibend“ werden
  verworfen, Einträge wie „Jetzt anschauen Episode 1 von X“ auf „X“ gekürzt und übernommen.
- Sync über eine Crunchyliste im Konto.
- Auf Serien- und Player-Seiten wird nichts ausgeblendet, damit du eine ausgeblendete Serie
  gezielt öffnen kannst.
- Popup: Sync-Status, Suche in der Liste, Badges für „ausstehend“ und „nur lokal“
  (Titel ohne gefundene Serien-ID).


## Änderungen in v0.4.0

- Neue Kategorie **„Gesehen“** neben „Uninteressant“.
- Erkennung von Neuem: `last_public` der Serie bzw. Veröffentlichungsdatum der Folge wird mit
  dem Markierungsdatum verglichen; zusätzlich prüft der Sync alle 6 h pro Serie über
  `/content/v2/discover/up_next/{serie}`, ob es eine ungesehene, neu erschienene Folge gibt.
- Ankündigungen (`availability_notes`, z. B. „Neue Staffel ab 08.10“) im Popup.
- Karten: „✓ Gesehen“ und „✕“, „✨ Neu“-Badge; Popup mit zwei Reitern, Verschieben zwischen
  den Kategorien.
- Hinweis: Auch eine neu hinzugefügte Synchro-Fassung kann als „neu“ zählen, weil Crunchyroll
  dafür `last_public` aktualisiert.

## Änderungen in v0.4.2

- Fix: „Schau weiter“-Karten waren nicht mehr anklickbar. Crunchyroll legt seit 10/2026 eine
  Hover-Einblendung mit eigenem, absolut positioniertem Link über die Karte. Die Erweiterung
  hatte diesen Link als Karte erkannt und ihm `position: relative` gegeben – damit schrumpfte
  die Klickfläche auf null.
  - Links (`<a>`) und Hover-Einblendungen werden nie mehr als Karte behandelt.
  - `position: relative` wird nur noch bei statisch positionierten Karten gesetzt.
  - Karten-Selektoren greifen nur noch auf Wurzel-Elemente (`…--`), nicht auf innere Teile (`…__`).
