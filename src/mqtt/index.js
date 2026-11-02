const mqtt = require('mqtt');
const { parseNumber } = require('./parser');

function createSource(env) {
    const config = {
        brokerUrl: env.MQTT_URL,
        username: env.MQTT_USERNAME || undefined,
        password: env.MQTT_PASSWORD || undefined,
        topics: {
            l1: env.MQTT_TOPIC_L1,
            l2: env.MQTT_TOPIC_L2,
            l3: env.MQTT_TOPIC_L3,
            frequency: env.MQTT_TOPIC_FREQUENCY || '',
            forecast: env.MQTT_TOPIC_PV_FORECAST || '',
        },
        jsonKey: env.MQTT_JSON_KEY || '',
        forecastJsonKey: env.MQTT_PV_FORECAST_JSON_KEY || 'today.energy',
        maxValueAgeMs: Number(env.MQTT_MAX_VALUE_AGE_MS || 360000),
    };
    validateConfig(config);

    const values = new Map();
    const topics = Object.values(config.topics).filter(Boolean);

    function currentValue(topic, now) {
        const entry = values.get(topic);
        if (!entry || now - entry.receivedAt > config.maxValueAgeMs) return null;
        return entry.value;
    }

    return {
        getMeasurement() {
            const now = Date.now();
            const l1V = currentValue(config.topics.l1, now);
            const l2V = currentValue(config.topics.l2, now);
            const l3V = currentValue(config.topics.l3, now);
            if (![l1V, l2V, l3V].every((value) => Number.isFinite(value) && value >= 150 && value <= 300)) {
                return null;
            }

            const reading = { l1V, l2V, l3V };
            const frequencyHz = config.topics.frequency ? currentValue(config.topics.frequency, now) : null;
            if (Number.isFinite(frequencyHz)) reading.frequencyHz = frequencyHz;
            const forecastWh = config.topics.forecast ? currentValue(config.topics.forecast, now) : null;
            if (Number.isFinite(forecastWh) && forecastWh >= 0) reading.forecastKwh = forecastWh / 1000;
            return reading;
        },
        start({ onConnect, onUpdate }) {
            const client = mqtt.connect(config.brokerUrl, {
                username: config.username,
                password: config.password,
                reconnectPeriod: 5000,
            });

            client.on('connect', () => {
                values.clear();
                onConnect();
                client.subscribe(topics, (error) => {
                    if (error) console.warn(`MQTT: Abonnement fehlgeschlagen: ${error.message}`);
                    else console.info(`MQTT: verbunden, Topics abonniert: ${topics.join(', ')}`);
                });
            });
            client.on('error', (error) => console.warn(`MQTT: ${error.message}`));
            client.on('message', (topic, payload) => {
                const jsonKey = topic === config.topics.forecast ? config.forecastJsonKey : config.jsonKey;
                const value = parseNumber(payload, jsonKey);
                if (value === null) {
                    console.warn(`MQTT: Payload aus ${topic} nicht lesbar`);
                    return;
                }
                values.set(topic, { value, receivedAt: Date.now() });
                onUpdate();
            });

            return () => client.end();
        },
    };
}

function validateConfig(config) {
    if (!config.brokerUrl) throw new Error('MQTT_URL muss gesetzt sein');
    if (![config.topics.l1, config.topics.l2, config.topics.l3].every(Boolean)) {
        throw new Error('MQTT_TOPIC_L1, MQTT_TOPIC_L2 und MQTT_TOPIC_L3 müssen gesetzt sein');
    }
    if (!Number.isFinite(config.maxValueAgeMs) || config.maxValueAgeMs <= 0) {
        throw new Error('MQTT_MAX_VALUE_AGE_MS muss eine positive Zahl sein');
    }
}

module.exports = { createSource };