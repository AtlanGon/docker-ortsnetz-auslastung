const DEFAULT_API_URL = 'https://sunpilot.meinnetz.eu';
const FORECAST_KINDS = ['deterministic', 'ensemble_p10', 'ensemble_median', 'ensemble_p90'];

function createSource(env, fetchImpl = fetch) {
    if (!env.SUNPILOT_API_URL) return null;

    const config = {
        apiUrl: env.SUNPILOT_API_URL || DEFAULT_API_URL,
        plantId: env.SUNPILOT_PLANT_ID || '',
        token: env.SUNPILOT_API_TOKEN || '',
        timeZone: env.SUNPILOT_TIME_ZONE || 'Europe/Berlin',
        kind: env.SUNPILOT_FORECAST_KIND || 'deterministic',
    };
    validateConfig(config);

    let forecastKwh = null;

    return {
        getForecastKwh() {
            return forecastKwh;
        },
        async refresh(now = Date.now()) {
            const day = getLocalDate(now, config.timeZone);
            const url = new URL(
                `/api/v1/plants/${encodeURIComponent(config.plantId)}/forecasts/power_pv`,
                config.apiUrl,
            );
            url.searchParams.set('from', day);
            url.searchParams.set('to', day);

            const headers = { Accept: 'application/json' };
            if (config.token) headers.Authorization = `Bearer ${config.token}`;

            const response = await fetchImpl(url, {
                headers,
                signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const body = await response.json();
            if (!Array.isArray(body.energy_per_day)) {
                throw new Error('Antwort enthält kein energy_per_day-Array');
            }
            const dailyForecast = body.energy_per_day.find((entry) => entry.day === day);
            const value = dailyForecast?.energy_kwh?.total?.[config.kind];
            forecastKwh = Number.isFinite(value) && value >= 0 ? value : null;
            if (forecastKwh === null) {
                throw new Error(`Kein Tageswert für ${day} (${config.kind}) vorhanden`);
            }
            return forecastKwh;
        },
    };
}

function getLocalDate(now, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(now));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const date = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
    return date.toISOString().slice(0, 10);
}

function validateConfig(config) {
    if (!config.plantId) throw new Error('SUNPILOT_PLANT_ID muss gesetzt sein');
    if (!FORECAST_KINDS.includes(config.kind)) {
        throw new Error(`SUNPILOT_FORECAST_KIND muss einer dieser Werte sein: ${FORECAST_KINDS.join(', ')}`);
    }
    try {
        new URL(config.apiUrl);
        new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone });
    } catch {
        throw new Error('SUNPILOT_API_URL oder SUNPILOT_TIME_ZONE ist ungültig');
    }
}

module.exports = { createSource, getLocalDate };