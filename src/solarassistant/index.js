function createSource(env, fetchImpl = fetch) {
    const config = {
        apiUrl: env.SA_API_URL,
        username: env.SA_API_USERNAME || 'admin',
        password: env.SA_API_PASSWORD || '',
        token: env.SA_API_TOKEN || '',
        topics: {
            l1: env.SA_METRIC_TOPIC_L1 || '',
            l2: env.SA_METRIC_TOPIC_L2 || '',
            l3: env.SA_METRIC_TOPIC_L3 || '',
            frequency: env.SA_METRIC_TOPIC_FREQUENCY || '',
            l1A: env.SA_METRIC_TOPIC_L1_A || '',
            l2A: env.SA_METRIC_TOPIC_L2_A || '',
            l3A: env.SA_METRIC_TOPIC_L3_A || '',
            powerFactor: env.SA_METRIC_TOPIC_POWER_FACTOR || '',
            gridPower: env.SA_METRIC_TOPIC_GRID_POWER_W || '',
            apparentPower: env.SA_METRIC_TOPIC_APPARENT_POWER_VA || '',
            batterySoc: env.SA_METRIC_TOPIC_BATTERY_SOC_PERCENT || '',
        },
    };
    validateConfig(config);

    const metricsUrl = getMetricsUrl(config.apiUrl);
    const headers = { Accept: 'application/json' };
    if (config.token) {
        headers.Authorization = `Bearer ${config.token}`;
    } else {
        const credentials = Buffer.from(`${config.username}:${config.password}`).toString('base64');
        headers.Authorization = `Basic ${credentials}`;
    }

    let measurement = null;

    return {
        getMeasurement() {
            return measurement;
        },
        async refresh() {
            const response = await fetchImpl(metricsUrl, {
                headers,
                signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) {
                throw new Error(`SolarAssistant API HTTP ${response.status}`);
            }

            const body = await response.json();
            if (!Array.isArray(body)) {
                throw new Error('SolarAssistant API lieferte keine Metrikliste');
            }
            const values = new Map(body.map((metric) => [metric.topic, Number(metric.value)]));
            measurement = {
                l1V: values.get(config.topics.l1),
                l2V: values.get(config.topics.l2),
                l3V: values.get(config.topics.l3),
            };
            if (config.topics.frequency) {
                measurement.frequencyHz = values.get(config.topics.frequency);
            }
            for (const [topicKey, readingKey] of [
                ['l1A', 'l1A'], ['l2A', 'l2A'], ['l3A', 'l3A'],
                ['powerFactor', 'powerFactor'], ['gridPower', 'gridPowerW'],
                ['apparentPower', 'apparentPowerVa'], ['batterySoc', 'batterySocPercent'],
            ]) {
                const topic = config.topics[topicKey];
                if (topic) measurement[readingKey] = values.get(topic);
            }
            return measurement;
        },
        start({ onConnect, onUpdate }) {
            onConnect();
            void this.refresh()
                .then((reading) => onUpdate(reading))
                .catch((error) => console.warn(`SolarAssistant API: ${error.message}`));
            return () => {};
        },
    };
}

function getMetricsUrl(apiUrl) {
    const baseUrl = apiUrl.replace(/\/+$/, '');
    return baseUrl.endsWith('/api/v1/metrics')
        ? baseUrl
        : `${baseUrl}/api/v1/metrics`;
}

function validateConfig(config) {
    if (!config.apiUrl) throw new Error('SA_API_URL muss gesetzt sein');
    if (![config.topics.l1, config.topics.l2, config.topics.l3].every(Boolean)) {
        throw new Error('SA_METRIC_TOPIC_L1, SA_METRIC_TOPIC_L2 und SA_METRIC_TOPIC_L3 müssen gesetzt sein');
    }
    if (!config.token && !config.password) {
        throw new Error('SA_API_PASSWORD oder SA_API_TOKEN muss gesetzt sein');
    }
    try {
        new URL(getMetricsUrl(config.apiUrl));
    } catch {
        throw new Error('SA_API_URL muss eine gültige URL sein');
    }
}

module.exports = { createSource, getMetricsUrl };