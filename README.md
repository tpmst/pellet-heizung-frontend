# Pellet-Heizung Dashboard

Web-Dashboard zur Überwachung einer Pellet-Heizung. Das Frontend läuft im
Browser, authentifiziert Benutzer über Firebase Authentication und liest
Mess- und Heizungsdaten aus Cloud Firestore.

Die Messwerte werden von einem ESP32 erfasst. Die ETA-Heizung selbst bleibt im
lokalen Netzwerk: Der ESP32 liest ihre lokale ETA-API aus und überträgt die
relevanten Daten anschließend in die Cloud. Dadurch muss die Heizung nicht
direkt aus dem Internet erreichbar sein.

## Systemübersicht

```text
ETA-Heizung ── lokale HTTP/XML-API ──> ESP32
                                      │
                                      └── WLAN + Firestore REST API ──> Firebase
                                                                          │
                                      Browser <── Firebase Auth/Firestore ──┘
```

Das Frontend ist Teil des Gesamtsystems und wird durch die Firmware aus dem
separaten Repository [`tpmst/esp32-HC-SR04-AHT25-firebase`](https://github.com/tpmst/esp32-HC-SR04-AHT25-firebase)
mit Daten versorgt.

## Funktionen

- Anmeldung mit Firebase E-Mail/Passwort
- Messwerte der letzten 30 Tage als Linien-Diagramme:
  - Restvolumen in m³
  - Restfüllhöhe in cm
  - Temperatur in °C
  - Luftfeuchtigkeit in %
- Anzeige der zuletzt eingegangenen Messung
- ETA-Heizungsstatus mit:
  - Ein-/Aus-Zustand
  - Brennstoffmenge aus ETA-XML
  - Aschemenge beziehungsweise Schätzwert
  - aktuellen Fehlermeldungen aus der ETA-API
- helles und dunkles Farbschema über `prefers-color-scheme`
- optionale Firebase Cloud Functions für Warnungen, Füllstandsprüfung,
  Geräteausfall-Erkennung und Status-E-Mails

## ETA-API-Connector

Der Sketch `eta-api-connector.ino` im ESP32-Repository ist die Brücke zwischen
der lokalen ETA-Heizungssteuerung und Firebase:

1. Der ESP32 verbindet sich mit dem WLAN und liest die ETA-API über HTTP aus.
2. Er fragt den Anlagenstatus, die Brennstoffmenge, die Aschemenge und
   Fehlermeldungen als XML ab.
3. Eine Änderung zwischen `Ein`, `Aus` und `Abstellen` wird erkannt und
   unmittelbar in `heizung/status_heizung` gespeichert.
4. Bei einer Statusänderung oder spätestens alle zwölf Stunden werden die
   vollständigen XML-Daten als neues Dokument in `heizung` abgelegt.
5. Nach dem Upload trennt sich der ESP32 vom WLAN und geht für fünf Minuten in
   Deep Sleep.

Der Connector benötigt daher keinen öffentlich erreichbaren ETA-Endpunkt. Nur
der ESP32 muss gleichzeitig Zugriff auf die lokale ETA-IP-Adresse und auf
Firebase haben. Die im Sketch konfigurierten ETA-Pfade sind:

| Daten | ETA-API-Pfad |
| --- | --- |
| Betriebsstatus | `/user/var/264/10891/0/0/12080` |
| Aschemenge | `/user/var/264/10891/0/0/12013` |
| Brennstoffmenge | `/user/var/264/10891/0/0/12016` |
| Fehlermeldungen | `/user/errors` |

### Connector einrichten

1. [`eta-api-connector.ino`](https://github.com/tpmst/esp32-HC-SR04-AHT25-firebase/blob/main/eta-api-connector.ino)
   in der Arduino IDE oder PlatformIO öffnen.
2. WLAN, Firebase-Projekt und Firestore-Host eintragen.
3. `etaHost` auf die lokale IP-Adresse der ETA-Heizung setzen. Der Connector
   verwendet standardmäßig Port `8080`.
4. Den Sketch auf den ESP32 laden und den seriellen Monitor zur Kontrolle der
   WLAN-, ETA- und Firestore-Verbindungen verwenden.

Geheimnisse wie WLAN-Passwort und Firestore-Schlüssel dürfen nicht in ein
öffentliches Repository gelangen. Die Firestore Security Rules und die
Authentifizierung des Connectors müssen so aufeinander abgestimmt sein, dass
der Connector schreiben und das Dashboard ausschließlich lesend auf die
benötigten Daten zugreifen kann.

## Voraussetzungen

- Node.js für das Frontend und die Cloud Functions
- ein Firebase-Projekt mit aktiviertem Firestore
- aktivierte Firebase-Authentication-Methode **E-Mail/Passwort**
- mindestens ein angelegter Firebase-Benutzer
- für den Connector: ESP32, WLAN und eine im lokalen Netz erreichbare ETA-API
- für die Cloud Functions zusätzlich Firebase CLI, Cloud Scheduler und ein
  Gmail-/SMTP-Konto

## Frontend lokal starten

Repository klonen und Abhängigkeiten installieren:

```bash
git clone https://github.com/tpmst/pellet-heizung-frontend.git
cd pellet-heizung-frontend
npm install
```

Firebase-Konfiguration aus der Vorlage erzeugen:

```bash
copy config.js.example config.js
```

Unter macOS/Linux:

```bash
cp config.js.example config.js
```

Danach die Werte aus **Project settings → Your apps → SDK setup and
configuration** in `config.js` eintragen. Die Datei wird nicht versioniert.

Lokalen HTTP-Server starten:

```bash
npx vite --host 127.0.0.1
```

Die von Vite ausgegebene URL im Browser öffnen. `index.html` sollte nicht direkt
über `file://` geöffnet werden, weil ES-Module und Firebase einen HTTP-Kontext
benötigen.

## Firestore-Datenmodell

### `measurements`

Das Dashboard liest die letzten 30 Tage aus `measurements`. `timestamp` kann ein
Firestore `Timestamp` oder ein Unix-Zeitstempel in Sekunden (alternativ
Millisekunden) sein.

```json
{
  "timestamp": 1710000000,
  "temperature": 21.4,
  "humidity": 48.2,
  "distance": 82
}
```

`temperature`, `humidity` und `distance` müssen numerisch sein. Die Rohdistanz
wird anhand der Anlagengeometrie in Füllhöhe und Restvolumen umgerechnet:

- Raumlänge: `4,13 m`
- Raumbreite: `2,15 m`
- Gesamthöhe: `187 cm`
- Sensor-Offset: `28 cm`
- Grundfläche: `8,8795 m²`

### `heizung`

Die ETA-Daten werden als zeitgestempelte Dokumente in `heizung` gespeichert.
Zusätzlich aktualisiert der Connector bei Statusänderungen das feste Dokument
`heizung/status_heizung`.

```json
{
  "timestamp": 1710000000,
  "ist_an": true,
  "xml_status": "<value strValue=\"Ein\" />",
  "xml_menge": "<value strValue=\"5\" unit=\"kg\" />",
  "xml_asche": "<value strValue=\"0.03\" unit=\"kg\" />",
  "xml_errors": ""
}
```

Die XML-Felder werden im Browser geparst. Attribute `msg="..."` werden als
aktuelle Meldungen beziehungsweise Fehler angezeigt.

## Cloud Functions

Die Funktionen liegen in `functions` und werden separat installiert und
bereitgestellt:

```bash
cd functions
npm install
firebase functions:secrets:set GMAIL_USER
firebase functions:secrets:set GMAIL_PASS
npm run deploy
```

| Funktion | Auslöser | Zweck |
| --- | --- | --- |
| `sendWarningEmail` | Neues Dokument in `warnings/{warningId}` | Warnungen an Firebase-Benutzer; maximal drei E-Mails pro Tag mit mindestens sechs Stunden Abstand |
| `checkDailyPelletLevel` | Zeitplan `0 8 */2 * *` | Füllstandsprüfung alle zwei Tage um 08:00 Uhr und Geräteausfall-Erkennung nach mehr als 50 Stunden ohne Messung |
| `sendHeatingStatusEmail` | Änderung an `heizung/status_heizung` | E-Mail beim Ein- oder Ausschalten der Heizung |

Die Füllstandsprüfung kann über `metadata/settings.levelCheckEnabled`
deaktiviert werden. Fehlt das Feld, ist sie standardmäßig aktiviert.

## Projektstruktur

```text
.
├── app.js                 # Firebase-Initialisierung, Authentifizierung und Dashboard-Logik
├── config.js.example      # Vorlage für die Firebase-Web-Konfiguration
├── index.html             # Login, Statusanzeige und Diagramme
├── styles.css             # Layout und helles/dunkles Farbschema
└── functions/
    ├── index.js           # Firebase Cloud Functions
    └── package.json       # Abhängigkeiten und Deploy-Skripte
```

Chart.js wird in `index.html` über ein CDN eingebunden. Die Firebase-Web-SDKs
werden als ES-Module direkt von `gstatic.com` geladen.

## Lizenz

Dieses Projekt steht unter der in [`LICENSE`](LICENSE) angegebenen Lizenz.
