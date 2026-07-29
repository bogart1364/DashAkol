const { createClient } = require('@libsql/client');

function getClient() {
    return createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
    });
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
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
            status TEXT DEFAULT 'pending',
            telegram_username TEXT,
            telegram_chat_id TEXT,
            telegram_message_id TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )`);
        // Migrate: add columns if missing
        for (const col of ['status', 'telegram_username', 'telegram_chat_id', 'telegram_message_id']) {
            try { await db.execute(`ALTER TABLE bookings ADD COLUMN ${col} TEXT`); } catch {}
        }
    } catch (e) {
        return res.status(500).json({ error: 'DB init failed', detail: e.message });
    }

    if (req.method === 'GET') {
        try {
            const result = await db.execute('SELECT id, date_key, time, name, phone, service, stylist, status, telegram_username, telegram_chat_id, telegram_message_id FROM bookings ORDER BY id ASC');
            const bookings = {};
            for (const row of result.rows) {
                if (!bookings[row.date_key]) bookings[row.date_key] = [];
                bookings[row.date_key].push({ id: row.id, time: row.time, name: row.name, phone: row.phone, service: row.service, stylist: row.stylist, status: row.status, telegram_username: row.telegram_username, telegram_chat_id: row.telegram_chat_id, telegram_message_id: row.telegram_message_id });
            }
            return res.status(200).json(bookings);
        } catch (e) {
            return res.status(500).json({ error: 'Fetch failed', detail: e.message });
        }
    }

    if (req.method === 'POST') {
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); } }

        const { date_key, time, name, phone, service, stylist, telegram_username, telegram_chat_id, telegram_message_id } = body || {};
        if (!date_key || !time || !name || !phone || !service) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        try {
            const result = await db.execute({
                sql: 'INSERT INTO bookings (date_key, time, name, phone, service, stylist, telegram_username, telegram_chat_id, telegram_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                args: [date_key, time, name, phone, service, stylist || 'any', telegram_username || null, telegram_chat_id || null, telegram_message_id || null]
            });
            return res.status(200).json({ success: true, booking_id: Number(result.lastInsertRowid) });
        } catch (e) {
            return res.status(500).json({ error: 'Insert failed', detail: e.message });
        }
    }

    if (req.method === 'PATCH') {
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); } }

        const { id, status, telegram_chat_id, telegram_message_id } = body || {};
        if (!id || !status) {
            return res.status(400).json({ error: 'Missing id or status' });
        }

        try {
            if (telegram_chat_id && telegram_message_id) {
                await db.execute({ sql: 'UPDATE bookings SET status = ?, telegram_chat_id = ?, telegram_message_id = ? WHERE id = ?', args: [status, telegram_chat_id, telegram_message_id, id] });
            } else {
                await db.execute({ sql: 'UPDATE bookings SET status = ? WHERE id = ?', args: [status, id] });
            }
            return res.status(200).json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: 'Update failed', detail: e.message });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
};
