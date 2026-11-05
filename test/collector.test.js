const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const mqtt = require('mqtt');
const { buildPayload, createUploader, loadConfig } = require('../src');
const { parseNumber } = require('../src/mqtt/parser');
const { createSource: createMqttSource } = require('../src/mqtt');
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

test('reads configured optional values from MQTT topics', () => {
    const originalConnect = mqtt.connect;
    const client = new EventEmitter();
    client.subscribe = (_topics, callback) => callback(null);
    client.end = () => {};
    mqtt.connect = () => client;

    try {
        const source = createMqttSource({
            MQTT_URL: 'mqtt://broker.local',
            MQTT_TOPIC_L1: 'grid/l1_v',
            MQTT_TOPIC_L2: 'grid/l2_v',
            MQTT_TOPIC_L3: 'grid/l3_v',
            MQTT_TOPIC_L1_A: 'grid/l1_a',
            MQTT_TOPIC_POWER_FACTOR: 'grid/pf',
            MQTT_TOPIC_GRID_POWER_W: 'grid/power',
            MQTT_TOPIC_APPARENT_POWER_VA: 'grid/apparent',
            MQTT_TOPIC_BATTERY_SOC_PERCENT: 'battery/soc',
        });
        const stop = source.start({ onConnect: () => {}, onUpdate: () => {} });
        client.emit('connect');
        for (const [topic, value] of [
            ['grid/l1_v', 230], ['grid/l2_v', 231], ['grid/l3_v', 229],
            ['grid/l1_a', 1.2], ['grid/pf', 0.97], ['grid/power', -320],
            ['grid/apparent', 1250], ['battery/soc', 0],
        ]) {
            client.emit('message', topic, Buffer.from(String(value)));
        }

        assert.deepEqual(source.getMeasurement(), {
            l1V: 230, l2V: 231, l3V: 229,
            l1A: 1.2, powerFactor: 0.97, gridPowerW: -320,
            apparentPowerVa: 1250, batterySocPercent: 0,
        });
        stop();
    } finally {
        mqtt.connect = originalConnect;
    }
});

test('builds the common API payload from normalized source values', () => {
    const config = loadConfig(env);
    const now = Date.parse('2026-11-02T12:00:00Z');
    const reading = {
        l1V: 230, l2V: 231, l3V: 229, frequencyHz: 50,
        l1A: 1.2, l2A: -0.8, l3A: 0.4, powerFactor: 0.97,
        gridPowerW: -320, apparentPowerVa: 1250, batterySocPercent: 0,
        forecastKwh: 4.2,
    };

    assert.deepEqual(buildPayload(config, reading, now), {
        observed_at: '2026-11-02T12:00:00.000Z',
        latitude: 52.5,
        longitude: 13.4,
        l1_v: 230,
        l2_v: 231,
        l3_v: 229,
        integration_version: 'docker-0.3.0',
        grid_frequency_hz: 50,
        l1_a: 1.2,
        l2_a: 0.8,
        l3_a: 0.4,
        power_factor: 0.97,
        grid_power_w: -320,
        apparent_power_va: 1250,
        battery_soc_percent: 0,
        pv_forecast_kwh: 4.2,
    });
});

test('includes configured static capacity and omits invalid optional readings', () => {
    const config = loadConfig({ ...env, PLANT_CAPACITY_KWP: '9.8', BATTERY_CAPACITY_KWH: '12.5' });
    const payload = buildPayload(config, {
        l1V: 230, l2V: 231, l3V: 229,
        l1A: Number.NaN, l2A: -1, powerFactor: 1.2,
        gridPowerW: -450, apparentPowerVa: 0, batterySocPercent: 101,
    });

    assert.equal(payload.plant_capacity_kwp, 9.8);
    assert.equal(payload.battery_capacity, 12.5);
    assert.equal(payload.l2_a, -1);
    assert.equal(payload.grid_power_w, -450);
    assert.equal(payload.apparent_power_va, 0);
    assert.equal('l1_a' in payload, false);
    assert.equal(payload.l2_a, -1);
    assert.equal('power_factor' in payload, false);
    assert.equal('battery_soc_percent' in payload, false);
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
        SA_METRIC_TOPIC_L1_A: 'ac_input_1/current_l1',
        SA_METRIC_TOPIC_L2_A: 'ac_input_1/current_l2',
        SA_METRIC_TOPIC_L3_A: 'ac_input_1/current_l3',
        SA_METRIC_TOPIC_POWER_FACTOR: 'ac_input_1/power_factor',
        SA_METRIC_TOPIC_GRID_POWER_W: 'grid/power',
        SA_METRIC_TOPIC_APPARENT_POWER_VA: 'grid/apparent_power',
        SA_METRIC_TOPIC_BATTERY_SOC_PERCENT: 'battery/soc',
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
                { topic: 'ac_input_1/current_l1', value: 1.2 },
                { topic: 'ac_input_1/current_l2', value: 0.8 },
                { topic: 'ac_input_1/current_l3', value: 0.4 },
                { topic: 'ac_input_1/power_factor', value: 0.97 },
                { topic: 'grid/power', value: -320 },
                { topic: 'grid/apparent_power', value: 1250 },
                { topic: 'battery/soc', value: 0 },
            ],
        };
    });

    assert.deepEqual(await source.refresh(), {
        l1V: 230,
        l2V: 231,
        l3V: 229,
        frequencyHz: 50,
        l1A: 1.2,
        l2A: 0.8,
        l3A: 0.4,
        powerFactor: 0.97,
        gridPowerW: -320,
        apparentPowerVa: 1250,
        batterySocPercent: 0,
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
        SUNPILOT_API_TOKEN: 'Bearer forecast-token',
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

test('reports SunPilot 401 without revealing the configured token', async () => {
    let requestCount = 0;
    const source = createSunPilotSource({
        SUNPILOT_API_URL: 'https://sunpilot.example',
        SUNPILOT_PLANT_ID: 'test-plant',
        SUNPILOT_API_TOKEN: 'secret-token',
    }, async () => {
        requestCount += 1;
        return { ok: false, status: 401 };
    });

    await assert.rejects(source.refresh(Date.parse('2026-11-02T18:04:00Z')), {
        message: /HTTP 401 \(SUNPILOT_API_TOKEN wurde als Bearer und X-API-Key abgelehnt/,
    });
    assert.equal(requestCount, 2);
});

test('auth diagnostics print a fingerprint but never the token', () => {
    const token = 'test-secret-3';
    const messages = [];
    const originalInfo = console.info;
    console.info = (message) => messages.push(message);

    try {
        createSunPilotSource({
            SUNPILOT_API_URL: 'https://sunpilot.example',
            SUNPILOT_PLANT_ID: 'test-plant',
            SUNPILOT_API_TOKEN: token,
            SUNPILOT_AUTH_DIAGNOSTICS: 'true',
        }, async () => ({ ok: false, status: 401 }));
    } finally {
        console.info = originalInfo;
    }

    const output = messages.join('\n');
    const fingerprint = createHash('sha256').update(token).digest('hex');
    assert.match(output, /tokenPresent=true/);
    assert.match(output, /tokenLength=13/);
    assert.ok(output.includes(`tokenSHA256=${fingerprint}`));
    assert.equal(output.includes(token), false);
});

test('retries SunPilot with X-API-Key after Bearer authentication fails', async () => {
    const requestHeaders = [];
    const source = createSunPilotSource({
        SUNPILOT_API_URL: 'https://sunpilot.example',
        SUNPILOT_PLANT_ID: 'test-plant',
        SUNPILOT_API_TOKEN: 'test-token',
    }, async (_url, options) => {
        requestHeaders.push(options.headers);
        if (requestHeaders.length === 1) return { ok: false, status: 401 };
        return {
            ok: true,
            json: async () => ({
                energy_per_day: [
                    { day: '2026-11-02', energy_kwh: { total: { deterministic: 3.32 } } },
                ],
            }),
        };
    });

    assert.equal(await source.refresh(Date.parse('2026-11-02T18:04:00Z')), 3.32);
    assert.equal(requestHeaders[0].Authorization, 'Bearer test-token');
    assert.equal(requestHeaders[1]['X-API-Key'], 'test-token');
    assert.equal(requestHeaders[1].Authorization, undefined);
});

test('rejects unsupported data source names', () => {
    assert.throws(() => loadConfig({ ...env, DATA_SOURCE: 'unsupported' }), /DATA_SOURCE/);
});