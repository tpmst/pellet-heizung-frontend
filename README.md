# Pellet-Heizung Dashboard

Ein schlankes Web-Dashboard zur Überwachung einer Pellet-Heizung. Die Anwendung
läuft vollständig im Browser, verwendet Firebase Authentication für den Login
und liest Mess- und Heizungsdaten aus Cloud Firestore.

## Funktionen

- Anmeldung mit Firebase E-Mail/Passwort
- Messwerte der letzten 30 Tage als Linien-Diagramme:
  - Restvolumen in m³
  - Restfüllhöhe in cm
  - Temperatur in °C
  - Luftfeuchtigkeit in %
- Anzeige der zuletzt eingegangenen Messung
- Anzeige des aktuellen Heizungsstatus:
  - Ein-/Aus-Zustand
  - Gesamtmenge aus ETA-XML-Daten
  - geschätzte oder aus XML gelesene Aschemenge
  - aktuelle Fehlermeldungen aus XML-Attributen
- Helles und dunkles Farbschema über `prefers-color-scheme`
- Optionale Firebase Cloud Functions für:
  - Warn-E-Mails bei neuen Dokumenten in `warnings`
  - regelmäßige Füllstands- und Geräteausfallprüfung
  - E-Mails bei Änderungen des Heizungsstatus

## Voraussetzungen

- Node.js 24 oder kompatible Node.js-Version für die Cloud Functions
- Ein Firebase-Projekt mit:
  - aktiviertem Firestore
  - aktivierter Authentication-Methode **E-Mail/Passwort**
  - mindestens einem angelegten Benutzer
- Für die Cloud Functions zusätzlich ein Gmail-/SMTP-Konto und ein
  Firebase-Projekt mit aktiviertem Cloud Scheduler

## Installation und lokaler Start

1. Repository klonen und in das Projektverzeichnis wechseln:

   ```bash
   git clone https://github.com/tpmst/pellet-heizung-frontend.git
   cd pellet-heizung-frontend
   ```

2. Abhängigkeiten installieren:

   ```bash
   npm install
   ```

3. Firebase-Konfiguration anlegen:

   ```bash
   copy config.js.example config.js
   ```

   Unter macOS/Linux:

   ```bash
   cp config.js.example config.js
   ```

   Anschließend die Werte in `config.js` aus den Firebase-Web-App-Einstellungen
   eintragen. `config.js` wird nicht versioniert und darf keine Zugangsdaten
   enthalten, die als Server-Geheimnisse gedacht sind.

4. Einen lokalen HTTP-Server starten:

   ```bash
   npx vite --host 127.0.0.1
   ```

   Danach die von Vite ausgegebene lokale URL im Browser öffnen. Die HTML-Datei
   sollte nicht direkt über `file://` geöffnet werden, weil das ES-Modul
   `app.js` und Firebase einen HTTP-Kontext benötigen.

## Firebase-Konfiguration

Die Web-Konfiguration wird in `config.js` erwartet:

```js
export const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "...",
  measurementId: "..."
};
```

Die benötigten Werte stehen in der Firebase Console unter
**Project settings → Your apps → SDK setup and configuration**.

Firestore- und Authentication-Regeln müssen im Firebase-Projekt so konfiguriert
sein, dass nur angemeldete Benutzer die Daten lesen können. Die im Frontend
sichtbare Firebase-Web-Konfiguration ist kein Ersatz für Firestore Security
Rules.

## Firestore-Datenmodell

### Collection `measurements`

Das Dashboard liest die letzten 30 Tage aus der Collection `measurements`.
`timestamp` kann entweder ein Firestore `Timestamp` oder ein Unix-Zeitstempel
in Sekunden (alternativ Millisekunden) sein.

Beispieldokument:

```json
{
  "timestamp": 1710000000,
  "temperature": 21.4,
  "humidity": 48.2,
  "distance": 82
}
```

`temperature`, `humidity` und `distance` müssen numerisch sein. Ungültige
Dokumente werden aus der Darstellung entfernt.

Die Rohdistanz wird für die Anzeige in eine Füllhöhe umgerechnet:

- Raumlänge: `4,13 m`
- Raumbreite: `2,15 m`
- Gesamthöhe: `187 cm`
- Sensor-Offset: `28 cm`
- Grundfläche: `8,8795 m²`

Dabei wird die Rohdistanz um den Sensor-Offset ergänzt, auf den gültigen
Höhenbereich begrenzt und daraus das Restvolumen berechnet.

### Collection `heizung`

Für die Anzeige des aktuellen Anlagenstatus wird das neueste Dokument aus
`heizung`, sortiert nach `timestamp`, verwendet. Unterstützte Felder sind:

```json
{
  "timestamp": 1710000000,
  "ist_an": true,
  "xml_menge": "<value strValue=\"5\" unit=\"kg\" />",
  "xml_asche": "<value strValue=\"0.03\" unit=\"kg\" />"
}
```

Die XML-Felder werden im Browser geparst. Attribute `msg="..."` werden als
aktuelle Meldungen beziehungsweise Fehler angezeigt.

## Cloud Functions

Die Funktionen liegen im Verzeichnis `functions` und werden separat installiert:

```bash
cd functions
npm install
```

Für den Versand von E-Mails werden die Firebase-Secrets `GMAIL_USER` und
`GMAIL_PASS` benötigt:

```bash
firebase functions:secrets:set GMAIL_USER
firebase functions:secrets:set GMAIL_PASS
```

Anschließend können die Functions mit der Firebase CLI bereitgestellt werden:

```bash
npm run deploy
```

Enthaltene Funktionen:

| Funktion | Auslöser | Zweck |
| --- | --- | --- |
| `sendWarningEmail` | Neues Dokument in `warnings/{warningId}` | Sendet Warnungen an alle Firebase-Benutzer; maximal drei E-Mails pro Tag mit mindestens sechs Stunden Abstand |
| `checkDailyPelletLevel` | Zeitplan `0 8 */2 * *` | Prüft alle zwei Tage um 08:00 Uhr den Füllstand und erkennt Geräteausfälle nach mehr als 50 Stunden ohne Messung |
| `sendHeatingStatusEmail` | Änderung an `heizung/status_heizung` | Informiert über das Ein- oder Ausschalten der Heizung |

Die Füllstandsprüfung kann über
`metadata/settings.levelCheckEnabled` deaktiviert werden. Fehlt das Feld, ist
die Prüfung standardmäßig aktiviert.

## Projektstruktur

```text
.
├── app.js                 # Firebase-Initialisierung, Authentifizierung und Dashboard-Logik
├── config.js.example      # Vorlage für die Firebase-Web-Konfiguration
├── index.html             # Markup für Login, Statusanzeige und Diagramme
├── styles.css             # Layout und helles/dunkles Farbschema
└── functions/
    ├── index.js           # Firebase Cloud Functions
    └── package.json       # Abhängigkeiten und Deploy-Skripte
```

Chart.js wird in `index.html` über ein CDN eingebunden. Die Firebase-Web-SDKs
werden als ES-Module direkt von `gstatic.com` geladen.

## Lizenz

Dieses Projekt steht unter der in [`LICENSE`](LICENSE) angegebenen Lizenz.
