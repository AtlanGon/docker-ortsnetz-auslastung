const API_URL_DEFAULT = 'https://www.ortsnetz-auslastung.de/v1/measurements';
const INTEGRATION_VERSION = 'docker-0.2.0';

function loadConfig(env = process.env) {
    const config = {
        apiUrl: env.API_URL || API_URL_DEFAULT,
        latitude: Number(env.LATITUDE),
        longitude: Number(env.LONGITUDE),
        plantCapacityKwp: env.PLANT_CAPACITY_KWP ? Number(env.PLANT_CAPACITY_KWP) : null,
        smartmeterModel: env.SMARTMETER_MODEL || '',
        source: env.DATA_SOURCE || 'mqtt',
        uploadIntervalMs: Number(env.UPLOAD_INTERVAL_MS || 300000),
    };

    if (!Number.isFinite(config.latitude) || config.latitude < -90 || config.latitude > 90) {
        throw new Error('LATITUDE muss eine Zahl zwischen -90 und 90 sein');
    }
    if (!Number.isFinite(config.longitude) || config.longitude < -180 || config.longitude > 180) {
        throw new Error('LONGITUDE muss eine Zahl zwischen -180 und 180 sein');
    }
    if (config.plantCapacityKwp !== null && (!Number.isFinite(config.plantCapacityKwp) || config.plantCapacityKwp <= 0)) {
        throw new Error('PLANT_CAPACITY_KWP muss eine positive Zahl sein');
    }
    if (!Number.isFinite(config.uploadIntervalMs) || config.uploadIntervalMs <= 0) {
        throw new Error('UPLOAD_INTERVAL_MS muss eine positive Zahl sein');
    }
    if (!['mqtt', 'solarassistant'].includes(config.source)) {
        throw new Error('DATA_SOURCE muss mqtt oder solarassistant sein');
    }
    return config;
}

function buildPayload(config, reading, now = Date.now()) {
    if (!reading || ![reading.l1V, reading.l2V, reading.l3V].every((value) => Number.isFinite(value) && value >= 150 && value <= 300)) {
        return null;
    }

    const payload = {
        observed_at: new Date(now).toISOString(),
        latitude: config.latitude,
        longitude: config.longitude,
        l1_v: reading.l1V,
        l2_v: reading.l2V,
        l3_v: reading.l3V,
        integration_version: INTEGRATION_VERSION,
    };
    if (config.smartmeterModel) payload.smartmeter_model = config.smartmeterModel;
    if (config.plantCapacityKwp !== null) payload.plant_capacity_kwp = config.plantCapacityKwp;
    if (Number.isFinite(reading.frequencyHz) && reading.frequencyHz >= 45 && reading.frequencyHz <= 55) {
        payload.grid_frequency_hz = reading.frequencyHz;
    }
    if (Number.isFinite(reading.forecastKwh) && reading.forecastKwh >= 0) {
        payload.pv_forecast_kwh = reading.forecastKwh;
    }
    return payload;
}

function createUploader(config, fetchImpl = fetch) {
    return async (reading) => {
        const payload = buildPayload(config, reading);
        if (!payload) {
            console.warn('Ortsnetz-Auslastung: aktuelle Spannungswerte fehlen oder sind ungültig; Upload übersprungen');
            return false;
        }

        try {
            const response = await fetchImpl(config.apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000),
            });
            const body = await response.text();
            if (response.status !== 202) {
                console.warn(`Ortsnetz-Auslastung: HTTP ${response.status}: ${body}`);
                return false;
            }
            console.info(`Ortsnetz-Auslastung: übertragene Messwerte: ${JSON.stringify(payload)}`);
            console.info(`Ortsnetz-Auslastung: Messung angenommen: ${body}`);
            return true;
        } catch (error) {
            console.warn(`Ortsnetz-Auslastung: Upload fehlgeschlagen: ${error.message}`);
            return false;
        }
    };
}

function loadSource(sourceName, env) {
    switch (sourceName) {
        case 'mqtt':
            return require('./mqtt').createSource(env);
        case 'solarassistant':
            return require('./solarassistant').createSource(env);
        default:
            throw new Error(`Unbekannte Datenquelle: ${sourceName}`);
    }
}

function start() {
    const config = loadConfig();
    const source = loadSource(config.source, process.env);
    const forecastSource = require('./sunpilot').createSource(process.env);
    const upload = createUploader(config);
    let initialUploadDone = false;
    let uploading = false;

    const uploadReading = async (reading) => {
        if (uploading) return;
        uploading = true;
        try {
            let currentReading = reading;
            if (forecastSource && buildPayload(config, currentReading)) {
                try {
                    await forecastSource.refresh();
                    const forecastKwh = forecastSource.getForecastKwh();
                    if (Number.isFinite(forecastKwh)) {
                        currentReading = { ...currentReading, forecastKwh };
                    }
                } catch (error) {
                    console.warn(`SunPilot: Prognose konnte nicht gelesen werden: ${error.message}`);
                }
            }
            await upload(currentReading);
        } finally {
            uploading = false;
        }
    };

    const refreshAndUpload = async () => {
        try {
            if (source.refresh) await source.refresh();
            await uploadReading(source.getMeasurement());
        } catch (error) {
            console.warn(`${config.source}: Messwerte konnten nicht gelesen werden: ${error.message}`);
        }
    };

    const stopSource = source.start({
        onConnect: () => { initialUploadDone = false; },
        onUpdate: (reading) => {
            const currentReading = reading || source.getMeasurement();
            if (!initialUploadDone && buildPayload(config, currentReading)) {
                initialUploadDone = true;
                void uploadReading(currentReading);
            }
        },
    });
    const timer = setInterval(() => void refreshAndUpload(), config.uploadIntervalMs);

    const shutdown = () => {
        clearInterval(timer);
        stopSource();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
}

if (require.main === module) {
    try {
        start();
    } catch (error) {
        console.error(`Ortsnetz-Auslastung: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { buildPayload, createUploader, loadConfig };