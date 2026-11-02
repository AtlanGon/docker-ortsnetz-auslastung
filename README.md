# Datenübertragung für Ortsnetz-Auslastung via Docker-Container

Siehe: https://github.com/thomaslehmann1234/datenerfassung-ortsnetz-auslastung

## Docker-Collector

Der Collector liest Spannungen und optionale Messwerte aus MQTT und sendet sie an
`POST /v1/measurements` der Ortsnetz-Auslastung-API. Die gemeinsame API- und
Upload-Logik liegt in `src/index.js`; Quelladapter sind unter `src/mqtt` und
`src/solarassistant` getrennt.

1. `.env.example` nach `.env` kopieren.
2. In `.env` Standort, Broker-Zugang und MQTT-Topics eintragen.
3. Container starten: `docker compose up -d --build`
4. Protokoll ansehen: `docker compose logs -f collector`

Der erste Upload erfolgt, sobald für alle drei Phasen aktuelle Spannungswerte
vorliegen. Danach wird alle fünf Minuten gesendet. Veraltete Werte und
Spannungen außerhalb von 150 bis 300 V werden verworfen. MQTT-Payloads können
Zahlen oder JSON sein; `MQTT_JSON_KEY` und
`MQTT_PV_FORECAST_JSON_KEY` wählen bei Bedarf verschachtelte JSON-Felder.
Die MQTT-PV-Tagesprognose wird in Wh erwartet und vom Adapter für die API in kWh
umgerechnet.

Alle Laufzeitwerte stehen in `.env`; die Namen und Beispielwerte sind in
`.env.example` dokumentiert. Bei einem Broker auf dem Docker-Host kann
`mqtt://host.docker.internal:1883` verwendet werden. Bei einem Broker in einem
anderen Compose-Projekt muss stattdessen dessen erreichbarer Hostname bzw. dessen
IP-Adresse eingetragen werden.

## SolarAssistant REST-API

SolarAssistant stellt lokal `GET /api/v1/metrics` bereit. Im Adapter wird diese
REST-API statt MQTT verwendet. In SolarAssistant muss dafür ein Gerätepasswort
gesetzt sein; alternativ kann ein Bearer-Token in `.env` verwendet werden.

1. SolarAssistant-IP und Anmeldedaten in `SA_API_URL`, `SA_API_USERNAME` und
	`SA_API_PASSWORD` eintragen. Alternativ `SA_API_TOKEN` setzen.
2. `DATA_SOURCE=solarassistant` setzen.
3. Die API-Metriken unter `http://<solarassistant-ip>/api/v1/metrics` aufrufen
	und die Topics für L1, L2, L3 sowie optional Frequenz in die entsprechenden
	`SA_METRIC_TOPIC_*`-Variablen übernehmen.

Die verfügbaren Topics hängen vom Wechselrichter und der Messgeräte-Konfiguration
ab. Der Adapter erfindet keine fehlenden Phasenwerte: Wenn die SolarAssistant-API
keine drei passenden Phasenspannungen liefert, kann diese Quelle keine gültige
Messung an die Ortsnetz-API senden. SolarAssistant API und Datenbank sollten nur
im lokalen Netzwerk erreichbar sein.

## Deployment in Arcane

Arcane verwaltet den Collector als Compose-Projekt. Die Projektdateien müssen im
Arcane-Projektordner verfügbar sein, weil `compose.yaml` das Image mit `build: .`
aus dem Dockerfile baut.

1. Stelle sicher, dass `Dockerfile`, `compose.yaml`, `package.json`,
	`package-lock.json` und der Ordner `src` im Git-Repository vorhanden sind.
2. In Arcane **Projects** öffnen und **Create Project** wählen. Compose-Inhalt
	aus `compose.yaml` einfügen. Die Build-Dateien über Git-Sync oder den
	Projekt-Workspace hinzufügen.
3. Im Editor **Environment Configuration (.env)** Werte aus `.env.example`
	eintragen. Für MQTT `DATA_SOURCE=mqtt`, für die direkte SolarAssistant-API
	`DATA_SOURCE=solarassistant` setzen. Zugangsdaten nicht ins Git-Repository
	committen.
4. **Create Project** speichern. Arcane baut das Image und startet den Container.
5. Unter **Projects** den Projektstatus prüfen; die Logs des `collector`-Dienstes
	zeigen MQTT-Verbindung, API-Uploads und Fehler.

Es muss kein Port veröffentlicht werden: Der Collector baut nur ausgehend eine
Verbindung zum Messdaten-Endpunkt und zur jeweiligen Datenquelle auf. Für Broker
oder SolarAssistant auf demselben Docker-Host ist `host.docker.internal` bereits
in `compose.yaml` als Host-Alias eingetragen. Geräte im LAN werden mit ihrer
LAN-IP konfiguriert.