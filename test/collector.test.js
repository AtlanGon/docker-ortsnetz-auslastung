const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPayload, createUploader, loadConfig } = require('../src');
const { parseNumber } = require('../src/mqtt/parser');
const { createSource: createSolarAssistantSource } = require('../src/solarassistant');
const { createSource: createSunPilotSource } = require('../src/sunpilot');

const env = {
    LATITUDE: '52.5',
    LONGITUDE: '13.4',
    DATA_SOURCE: 'mqtt',
    UPLOAD_INTERVAL_MS: '300000',
};

test('reads numeric and nested JSON MQTT payloads', () => {
    assert.equal(parseNumber(Buffer.from('230.5')), 230.5);
    assert.equal(parseNumber(Buffer.from('{"value":"229.7"}'), 'value'), 229.7);
    assert.equal(parseNumber(Buffer.from('{"today":{"energy":4200}}'), 'today.energy'), 4200);
    assert.equal(parseNumber(Buffer.from('not a number')), null);
});

test('builds the common API payload from normalized source values', () => {
    const config = loadConfig(env);
    const now = Date.parse('2026-11-02T12:00:00Z');
    const reading = { l1V: 230, l2V: 231, l3V: 229, frequencyHz: 50, forecastKwh: 4.2 };

    assert.deepEqual(buildPayload(config, reading, now), {
        observed_at: '2026-11-02T12:00:00.000Z',
        latitude: 52.5,
        longitude: 13.4,
        l1_v: 230,
        l2_v: 231,
        l3_v: 229,
        integration_version: 'docker-0.2.0',
        grid_frequency_hz: 50,
        pv_forecast_kwh: 4.2,
    });
});

test('rejects missing and implausible source voltages', () => {
    const config = loadConfig(env);
    assert.equal(buildPayload(config, null), null);
    assert.equal(buildPayload(config, { l1V: 230, l2V: 231, l3V: 301 }), null);
});

test('logs the measurement payload after the API accepts it', async () => {
    const config = loadConfig(env);
    const loggedMessages = [];
    let sentPayload;
    const originalInfo = console.info;
    console.info = (message) => loggedMessages.push(message);

    try {
        const upload = createUploader(config, async (_url, options) => {
            sentPayload = JSON.parse(options.body);
            return { status: 202, text: async () => '{"accepted":true}' };
        });
        assert.equal(await upload({ l1V: 230, l2V: 231, l3V: 229, frequencyHz: 50 }), true);
    } finally {
        console.info = originalInfo;
    }

    assert.equal(sentPayload.l1_v, 230);
    assert.ok(loggedMessages.some((message) => message.includes('"l1_v":230')));
    assert.ok(loggedMessages.some((message) => message.includes('"grid_frequency_hz":50')));
});

test('reads SolarAssistant phase metrics through its authenticated REST API', async () => {
    let requestUrl;
    let requestOptions;
    const source = createSolarAssistantSource({
        SA_API_URL: 'http://solarassistant.local',
        SA_API_USERNAME: 'admin',
        SA_API_PASSWORD: 'secret',
        SA_METRIC_TOPIC_L1: 'ac_input_1/voltage_l1',
        SA_METRIC_TOPIC_L2: 'ac_input_1/voltage_l2',
        SA_METRIC_TOPIC_L3: 'ac_input_1/voltage_l3',
        SA_METRIC_TOPIC_FREQUENCY: 'ac_input_1/frequency',
    }, async (url, options) => {
        requestUrl = url;
        requestOptions = options;
        return {
            ok: true,
            status: 200,
            json: async () => [
                { topic: 'ac_input_1/voltage_l1', value: 230 },
                { topic: 'ac_input_1/voltage_l2', value: 231 },
                { topic: 'ac_input_1/voltage_l3', value: 229 },
                { topic: 'ac_input_1/frequency', value: 50 },
            ],
        };
    });

    assert.deepEqual(await source.refresh(), {
        l1V: 230,
        l2V: 231,
        l3V: 229,
        frequencyHz: 50,
    });
    assert.equal(requestUrl, 'http://solarassistant.local/api/v1/metrics');
    assert.equal(requestOptions.headers.Authorization, `Basic ${Buffer.from('admin:secret').toString('base64')}`);
});

test('accepts a SolarAssistant bearer token and a full metrics URL', async () => {
    let requestUrl;
    let requestOptions;
    const source = createSolarAssistantSource({
        SA_API_URL: 'http://solarassistant.local/api/v1/metrics',
        SA_API_TOKEN: 'test-token',
        SA_METRIC_TOPIC_L1: 'grid/l1',
        SA_METRIC_TOPIC_L2: 'grid/l2',
        SA_METRIC_TOPIC_L3: 'grid/l3',
    }, async (url, options) => {
        requestUrl = url;
        requestOptions = options;
        return { ok: true, status: 200, json: async () => [] };
    });
    await source.refresh();
    assert.equal(requestUrl, 'http://solarassistant.local/api/v1/metrics');
    assert.equal(requestOptions.headers.Authorization, 'Bearer test-token');
});

test('reads the current local-day total forecast from SunPilot', async () => {
    let requestUrl;
    let requestOptions;
    const source = createSunPilotSource({
        SUNPILOT_API_URL: 'https://sunpilot.example/',
        SUNPILOT_PLANT_ID: '12587.berlin.wisslerstrasse_15',
        SUNPILOT_API_TOKEN: 'forecast-token',
        SUNPILOT_TIME_ZONE: 'Europe/Berlin',
        SUNPILOT_FORECAST_KIND: 'ensemble_median',
    }, async (url, options) => {
        requestUrl = new URL(url);
        requestOptions = options;
        return {
            ok: true,
            json: async () => ({
                energy_per_day: [
                    { day: '2026-11-02', energy_kwh: { total: { ensemble_median: 8.1 } } },
                    { day: '2026-11-03', energy_kwh: { total: { ensemble_median: 3.56 } } },
                ],
            }),
        };
    });

    assert.equal(await source.refresh(Date.parse('2026-11-02T18:04:00Z')), 8.1);
    assert.equal(requestUrl.pathname, '/api/v1/plants/12587.berlin.wisslerstrasse_15/forecasts/power_pv');
    assert.equal(requestUrl.searchParams.get('from'), '2026-11-02');
    assert.equal(requestUrl.searchParams.get('to'), '2026-11-02');
    assert.equal(requestOptions.headers.Authorization, 'Bearer forecast-token');
});

test('rejects unsupported data source names', () => {
    assert.throws(() => loadConfig({ ...env, DATA_SOURCE: 'unsupported' }), /DATA_SOURCE/);
});