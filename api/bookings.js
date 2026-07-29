const { createClient } = require('@libsql/client');

const ALLOWED_ORIGIN = 'https://dash-akol.vercel.app';

function getClient() {
    return createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
    });
}

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sanitize(str, maxLen = 100) {
    if (typeof str !== 'string') return '';
    return str.replace(/[<>&"']/g, '').trim().slice(0, maxLen);
}

const VALID_SERVICES = ['hair', 'beard', 'classic', 'texturize', 'full', 'groom'];
const VALID_STYLISTS = ['any', 'reza', 'mehdi', 'amir', 'saeid'];

module.exports = async (req, res) => {
    setCors(res);
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
        for (const col of ['status', 'telegram_username', 'telegram_chat_id', 'telegram_message_id']) {
            try { await db.execute(`ALTER TABLE bookings ADD COLUMN ${col} TEXT`); } catch {}
        }
    } catch (e) {
        return res.status(500).json({ error: 'DB init failed' });
    }

    if (req.method === 'GET') {
        try {
            const result = await db.execute('SELECT id, date_key, time, service, stylist, status, name, phone FROM bookings ORDER BY id ASC');
            const bookings = {};
            for (const row of result.rows) {
                if (!bookings[row.date_key]) bookings[row.date_key] = [];
                bookings[row.date_key].push({
                    id: row.id, time: row.time, name: row.name,
                    phone: row.phone.slice(0, 4) + '***' + row.phone.slice(-3),
                    service: row.service, stylist: row.stylist, status: row.status
                });
            }
            return res.status(200).json(bookings);
        } catch (e) {
            return res.status(500).json({ error: 'Fetch failed' });
        }
    }

    if (req.method === 'POST') {
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); } }

        const { date_key, time, name, phone, service, stylist, telegram_username } = body || {};
        if (!date_key || !time || !name || !phone || !service) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const cleanName = sanitize(name, 50);
        const cleanPhone = sanitize(phone, 15);
        const cleanUsername = telegram_username ? sanitize(telegram_username.replace(/^@/, ''), 30) : null;

        if (!cleanName || cleanName.length < 2) return res.status(400).json({ error: 'Invalid name' });
        if (!/^09\d{8,9}$/.test(cleanPhone)) return res.status(400).json({ error: 'Invalid phone' });
        if (!VALID_SERVICES.includes(service)) return res.status(400).json({ error: 'Invalid service' });
        if (stylist && !VALID_STYLISTS.includes(stylist)) return res.status(400).json({ error: 'Invalid stylist' });

        try {
            await db.execute({
                sql: 'INSERT INTO bookings (date_key, time, name, phone, service, stylist, telegram_username) VALUES (?, ?, ?, ?, ?, ?, ?)',
                args: [sanitize(date_key, 20), sanitize(time, 10), cleanName, cleanPhone, service, stylist || 'any', cleanUsername]
            });
            const maxId = await db.execute('SELECT last_insert_rowid() as id');
            const booking_id = maxId.rows[0].id;
            return res.status(200).json({ success: true, booking_id });
        } catch (e) {
            return res.status(500).json({ error: 'Insert failed' });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
};
