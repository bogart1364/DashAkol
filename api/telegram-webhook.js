const { createClient } = require('@libsql/client');

function getClient() {
    return createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
    });
}

async function sendTelegram(token, chatId, text) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text })
    });
    return res.json();
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const token = process.env.TELEGRAM_BOT_TOKEN;

    // Debug GET
    if (req.method === 'GET') {
        const db = getClient();
        try {
            await db.execute(`CREATE TABLE IF NOT EXISTS telegram_users (chat_id TEXT PRIMARY KEY, username TEXT, first_name TEXT, created_at TEXT DEFAULT (datetime('now')))`);
            const users = await db.execute('SELECT * FROM telegram_users');
            const bookings = await db.execute('SELECT id, date_key, time, name, phone, service, stylist, status, telegram_username, telegram_chat_id FROM bookings ORDER BY id DESC LIMIT 10');
            return res.status(200).json({ users: users.rows, bookings: bookings.rows });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); } }

    // Handle /start command
    if (body.message) {
        const msg = body.message;
        const chatId = msg.chat.id;
        const text = msg.text || '';
        const username = (msg.from.username || '').replace(/^@/, '');
        const firstName = msg.from.first_name || '';
        const personalId = String(msg.from.id);

        const db = getClient();
        try {
            await db.execute(`CREATE TABLE IF NOT EXISTS telegram_users (chat_id TEXT PRIMARY KEY, username TEXT, first_name TEXT, created_at TEXT DEFAULT (datetime('now')))`);
            await db.execute({
                sql: 'INSERT OR REPLACE INTO telegram_users (chat_id, username, first_name) VALUES (?, ?, ?)',
                args: [personalId, username, firstName]
            });
        } catch (e) {
            console.error('[/start] DB error:', e.message);
        }

        if (text === '/start') {
            const isPrivate = chatId > 0;
            const replyTo = isPrivate ? chatId : personalId;
            await sendTelegram(token, replyTo, `سلام ${firstName}! 👋\n\nبه بات داش آکل خوش اومدی.\n\nوقتی نوبتت رو رزرو کنی، اینجا بهت خبر میدیم.\nفقط کافیه تو فرم رزرو، آیدی تلگرامت رو وارد کنی.`);
        }

        return res.status(200).json({ ok: true });
    }

    // Handle callback query (button clicks)
    if (body.callback_query) {
        const cb = body.callback_query;
        const data = cb.data || '';
        const adminChatId = cb.message.chat.id;
        const messageId = cb.message.message_id;
        const adminName = cb.from.first_name || 'ادمین';

        const match = data.match(/^(confirm|reject)_(\d+)$/);
        if (!match) {
            await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: cb.query_id, text: 'دکمه نامعتبر!' })
            });
            return res.status(200).json({ ok: true });
        }

        const action = match[1];
        const bookingId = parseInt(match[2]);
        const newStatus = action === 'confirm' ? 'confirmed' : 'rejected';
        const statusEmoji = action === 'confirm' ? '✅' : '❌';
        const statusText = action === 'confirm' ? 'تایید شد' : 'رد شد';

        const db = getClient();
        const serviceNames = { hair: 'اصلاح مو', beard: 'فرم دهی ریش', classic: 'اصلاح کلاسیک', texturize: 'پیتاژ', full: 'پکیج مرد کامل', groom: 'پکیج داماد' };

        // Update status
        try {
            await db.execute({ sql: 'UPDATE bookings SET status = ? WHERE id = ?', args: [newStatus, bookingId] });
        } catch (e) { console.error('[CB] Update error:', e.message); }

        // Get booking
        let booking = null;
        try {
            const result = await db.execute({ sql: 'SELECT * FROM bookings WHERE id = ?', args: [bookingId] });
            if (result.rows.length > 0) booking = result.rows[0];
        } catch (e) { console.error('[CB] Select error:', e.message); }

        console.log('[CB] Booking found:', JSON.stringify(booking));

        // Edit original message
        try {
            const newText = cb.message.text + `\n\n${statusEmoji} ${statusText} توسط ${adminName}`;
            await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: adminChatId, message_id: messageId, text: newText })
            });
        } catch (e) { console.error('[CB] Edit error:', e.message); }

        // Answer callback
        try {
            await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: cb.query_id, text: `نوبت ${statusText}` })
            });
        } catch (e) { console.error('[CB] Answer error:', e.message); }

        // Build DM text
        if (booking) {
            const dmText = `${statusEmoji} نوبت شما ${statusText}!\n\n📅 تاریخ: ${booking.date_key}\n🕐 ساعت: ${booking.time}\n✂️ سرویس: ${serviceNames[booking.service] || booking.service}\n\n${action === 'confirm' ? 'منتظرتون هستیم! 🤝' : 'متأسفیم، نوبت شما رد شد.'}`;

            // Find user's personal chat_id
            let userChatId = null;

            // Method1: direct from booking
            if (booking.telegram_chat_id && Number(booking.telegram_chat_id) > 0) {
                userChatId = booking.telegram_chat_id;
                console.log('[DM] Using chat_id from booking:', userChatId);
            }

            // Method2: lookup by username in telegram_users
            if (!userChatId && booking.telegram_username) {
                try {
                    const uname = booking.telegram_username.toLowerCase();
                    const allUsers = await db.execute('SELECT chat_id, username FROM telegram_users');
                    console.log('[DM] All users:', JSON.stringify(allUsers.rows));
                    const matches = allUsers.rows.filter(r => (r.username || '').toLowerCase() === uname);
                    const personal = matches.find(r => Number(r.chat_id) > 0);
                    if (personal) {
                        userChatId = personal.chat_id;
                        console.log('[DM] Found personal chat_id:', userChatId);
                        // Save for next time
                        await db.execute({ sql: 'UPDATE bookings SET telegram_chat_id = ? WHERE id = ?', args: [userChatId, bookingId] });
                    } else if (matches.length > 0) {
                        console.log('[DM] Only group chat_ids found:', JSON.stringify(matches));
                    } else {
                        console.log('[DM] No user found for username:', uname);
                    }
                } catch (e) { console.error('[DM] Lookup error:', e.message); }
            }

            // Send DM
            if (userChatId) {
                try {
                    const dmResult = await sendTelegram(token, userChatId, dmText);
                    console.log('[DM] Sent:', JSON.stringify(dmResult));
                } catch (e) { console.error('[DM] Send error:', e.message); }
            } else {
                console.log('[DM] Could not find personal chat_id for user:', booking.telegram_username);
            }
        }

        return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
};
