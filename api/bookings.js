const { createClient } = require('@libsql/client');

function getClient() {
    return createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
    });
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const db = getClient();

    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date_key TEXT NOT NULL,
            time TEXT NOT NULL,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            service TEXT NOT NULL,
            stylist TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        )`);
    } catch (e) {
        return res.status(500).json({ error: 'DB init failed', detail: e.message });
    }

    if (req.method === 'GET') {
        try {
            const result = await db.execute('SELECT date_key, time, name, phone, service, stylist FROM bookings ORDER BY id ASC');
            const bookings = {};
            for (const row of result.rows) {
                if (!bookings[row.date_key]) bookings[row.date_key] = [];
                bookings[row.date_key].push({ time: row.time, name: row.name, phone: row.phone, service: row.service, stylist: row.stylist });
            }
            return res.status(200).json(bookings);
        } catch (e) {
            return res.status(500).json({ error: 'Fetch failed', detail: e.message });
        }
    }

    if (req.method === 'POST') {
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); } }

        const { date_key, time, name, phone, service, stylist } = body || {};
        if (!date_key || !time || !name || !phone || !service) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        try {
            await db.execute({
                sql: 'INSERT INTO bookings (date_key, time, name, phone, service, stylist) VALUES (?, ?, ?, ?, ?, ?)',
                args: [date_key, time, name, phone, service, stylist || 'any']
            });
            return res.status(200).json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: 'Insert failed', detail: e.message });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
};
