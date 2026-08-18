# pellet-heizung-frontend

Ein einfaches Frontend für Firebase Authentication + Firestore.

## Funktionen

- Login mit Firebase E-Mail/Passwort
- Lädt Messwerte aus der Collection `measurements` für die letzten 30 Tage
- Darstellung von `temperature`, `humidity` und `distance` in drei Linien-Graphen

## Datenformat in Firestore

Erwartete Felder pro Dokument in `measurements`:

- `timestamp` (Unix-Zeitstempel in Sekunden)
- `temperature` (Zahl)
- `humidity` (Zahl)
- `distance` (Zahl)

## Einrichtung

1. Firebase Projekt mit Authentication (E-Mail/Passwort) und Firestore bereitstellen.
2. In `/home/runner/work/pellet-heizung-frontend/pellet-heizung-frontend/app.js` das Objekt `firebaseConfig` mit deinen Werten befüllen.
3. Die Datei `/home/runner/work/pellet-heizung-frontend/pellet-heizung-frontend/index.html` im Browser öffnen oder einen statischen Server starten.
