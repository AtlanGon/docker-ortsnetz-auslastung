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
Eine MQTT-PV-Tagesprognose wird in Wh erwartet und für die API in kWh
umgerechnet. Alternativ kann SunPilot als unabhängige Prognosequelle konfiguriert
werden.

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

## SunPilot-Prognose

Optional ruft der Collector `GET /api/v1/plants/{plant}/forecasts/power_pv` ab
und liest den Gesamt-Tageswert aus
`energy_per_day[].energy_kwh.total.deterministic`. Diese Prognose ergänzt die
ausgewählte Messquelle; MQTT oder SolarAssistant liefern weiterhin die
Phasenspannungen.

Die SunPilot-URL, Plant-ID, Zeitzone und Prognosevariante sind in `.env.example`
konfiguriert. Abgefragt wird immer der aktuelle lokale Kalendertag in
`Europe/Berlin`; standardmäßig wird dessen deterministischer Gesamtwert
verwendet. Ein optionaler API-Token wird als Bearer-Token gesendet. Mit leerem
`SUNPILOT_API_URL` wird SunPilot deaktiviert.

## Deployment in Arcane

Arcane kann das GitHub-Repository direkt als Compose-Projekt synchronisieren.
Zuerst müssen die Änderungen aus diesem Workspace in den ausgewählten GitHub-
Branch übertragen werden. Der Compose-Build verwendet `build: .`, daher braucht
Arcane neben `compose.yaml` auch `Dockerfile`, `package*.json` und `src/`.

1. In Arcane **Projects** öffnen und im Menü neben **Create Project** den Punkt
	**From Git Repo** wählen.
2. **Pull** und **Target Type: Project** wählen, einen Projektnamen setzen und
	**Create a new project** verwenden.
3. Repository `https://github.com/AtlanGon/docker-ortsnetz-auslastung` und
	Branch `main` wählen. Als **Compose File Path** `compose.yaml` eintragen.
4. **Sync Files** aktivieren. Ohne diese Option übernimmt Arcane nur die Compose-
	Datei; Dockerfile und Quellcode fehlen dann im Build-Kontext.
5. Unter **Environment Configuration (.env)** die benötigten Werte aus
	`.env.example` eintragen. Für MQTT `DATA_SOURCE=mqtt`, für die direkte
	SolarAssistant-API `DATA_SOURCE=solarassistant` setzen. Zugangsdaten nicht
	ins Git-Repository committen.
6. **Add Sync** wählen. Arcane synchronisiert das Repository, baut das Image und
	startet das Projekt. Bei späteren Änderungen zuerst committen und pushen,
	danach in Arcane **Sync from Git** ausführen.
7. Unter **Projects** den Status prüfen; die Logs des `collector`-Dienstes zeigen
	Verbindungen, API-Uploads und Fehler.

Es muss kein Port veröffentlicht werden: Der Collector baut nur ausgehend eine
Verbindung zum Messdaten-Endpunkt und zur jeweiligen Datenquelle auf. Für Broker
oder SolarAssistant auf demselben Docker-Host ist `host.docker.internal` bereits
in `compose.yaml` als Host-Alias eingetragen. Geräte im LAN werden mit ihrer
LAN-IP konfiguriert.