function parseNumber(payload, jsonKey = '') {
    const text = payload.toString().trim();
    if (!text) return null;

    const direct = Number(text);
    if (Number.isFinite(direct)) return direct;

    try {
        const parsed = JSON.parse(text);
        const value = jsonKey
            ? jsonKey.split('.').reduce((node, key) => node == null ? undefined : node[key], parsed)
            : parsed;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    } catch {
        return null;
    }
}

module.exports = { parseNumber };