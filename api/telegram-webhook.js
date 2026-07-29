const { createClient } = require('@libsql/client');

function getClient() {
    return createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
    });
}

async function sendTelegram(token, chatId, text, replyMarkup) {
    const body = { chat_id: chatId, text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
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
            await db.execute("DELETE FROM telegram_users WHERE chat_id = '123456'");
            const users = await db.execute('SELECT * FROM telegram_users ORDER BY created_at DESC');
            const bookings = await db.execute('SELECT id, date_key, time, name, phone, service, stylist, status, telegram_username, telegram_chat_id FROM bookings ORDER BY id DESC LIMIT 10');
            return res.status(200).json({ users: users.rows, bookings: bookings.rows });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); } }

    const db = getClient();
    await db.execute(`CREATE TABLE IF NOT EXISTS telegram_users (chat_id TEXT PRIMARY KEY, username TEXT, first_name TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    await db.execute(`CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, date_key TEXT, time TEXT, name TEXT, phone TEXT, service TEXT, stylist TEXT, status TEXT DEFAULT 'pending', telegram_username TEXT, telegram_chat_id TEXT, telegram_message_id TEXT, created_at TEXT DEFAULT (datetime('now')))`);

    // Handle /start command
    if (body.message) {
        const msg = body.message;
        const chatId = msg.chat.id;
        const text = msg.text || '';
        const username = (msg.from.username || '').replace(/^@/, '');
        const firstName = msg.from.first_name || '';
        const personalId = String(msg.from.id);

        try {
            await db.execute({
                sql: 'INSERT OR REPLACE INTO telegram_users (chat_id, username, first_name) VALUES (?, ?, ?)',
                args: [personalId, username, firstName]
            });

            // Link to pending bookings
            if (username) {
                const uname = username.toLowerCase();
                const pending = await db.execute({ sql: "SELECT id FROM bookings WHERE LOWER(telegram_username) = ? AND (telegram_chat_id IS NULL OR telegram_chat_id = '')", args: [uname] });
                for (const row of pending.rows) {
                    await db.execute({ sql: 'UPDATE bookings SET telegram_chat_id = ? WHERE id = ?', args: [personalId, row.id] });
                }
            }
        } catch (e) {
            console.error('[/start] DB error:', e.message);
        }

        if (text === '/start') {
            const isPrivate = chatId > 0;
            const replyTo = isPrivate ? chatId : personalId;
            try {
                await sendTelegram(token, replyTo, `سلام ${firstName}!\n\nبه بات داش آکل خوش اومدی.\n\nروی دکمه زیر بزن تا وارد سایت بشی و نوبتت رو رزرو کنی.`, {
                    inline_keyboard: [[{ text: '💈 رزرو نوبت', url: 'https://dash-akol.vercel.app' }]]
                });
            } catch (e) {
                console.error('[/start] Reply error:', e.message);
            }
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
            try {
                await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ callback_query_id: cb.query_id, text: 'دکمه نامعتبر!' })
                });
            } catch {}
            return res.status(200).json({ ok: true });
        }

        const action = match[1];
        const bookingId = parseInt(match[2]);
        const newStatus = action === 'confirm' ? 'confirmed' : 'rejected';
        const statusEmoji = action === 'confirm' ? '✅' : '❌';
        const statusText = action === 'confirm' ? 'تایید شد' : 'رد شد';
        const serviceNames = { hair: 'اصلاح مو', beard: 'فرم دهی ریش', classic: 'اصلاح کلاسیک', texturize: 'پیتاژ', full: 'پکیج مرد کامل', groom: 'پکیج داماد' };

        // 1. Update status
        try {
            await db.execute({ sql: 'UPDATE bookings SET status = ? WHERE id = ?', args: [newStatus, bookingId] });
        } catch (e) { console.error('[CB] Update error:', e.message); }

        // 2. Get booking
        let booking = null;
        try {
            const result = await db.execute({ sql: 'SELECT * FROM bookings WHERE id = ?', args: [bookingId] });
            if (result.rows.length > 0) booking = result.rows[0];
        } catch (e) { console.error('[CB] Select error:', e.message); }

        // 3. Edit original message
        try {
            const newText = cb.message.text + `\n\n${statusEmoji} ${statusText} توسط ${adminName}`;
            await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: adminChatId, message_id: messageId, text: newText })
            });
        } catch (e) { console.error('[CB] Edit error:', e.message); }

        // 4. Answer callback
        try {
            await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: cb.query_id, text: `نوبت ${statusText}` })
            });
        } catch (e) { console.error('[CB] Answer error:', e.message); }

        // 5. Send DM
        if (booking) {
            const dmText = `${statusEmoji} نوبت شما ${statusText}!\n\n📅 تاریخ: ${booking.date_key}\n🕐 ساعت: ${booking.time}\n✂️ سرویس: ${serviceNames[booking.service] || booking.service}\n\n${action === 'confirm' ? 'منتظرتون هستیم!' : 'متأسفیم، نوبت شما رد شد.'}`;

            let userChatId = null;

            // Try saved chat_id first
            if (booking.telegram_chat_id && Number(booking.telegram_chat_id) > 0 && booking.telegram_chat_id !== '123456') {
                userChatId = booking.telegram_chat_id;
            }

            // Lookup by username
            if (!userChatId && booking.telegram_username) {
                try {
                    const uname = booking.telegram_username.toLowerCase();
                    const allUsers = await db.execute('SELECT chat_id, username, first_name FROM telegram_users ORDER BY created_at DESC');
                    const personal = allUsers.rows.find(r =>
                        (r.username || '').toLowerCase() === uname &&
                        Number(r.chat_id) > 0 &&
                        r.chat_id !== '123456'
                    );
                    if (personal) {
                        userChatId = personal.chat_id;
                        await db.execute({ sql: 'UPDATE bookings SET telegram_chat_id = ? WHERE id = ?', args: [userChatId, bookingId] });
                    }
                } catch (e) { console.error('[DM] Username lookup error:', e.message); }
            }

            // Fallback: name match
            if (!userChatId && booking.name) {
                try {
                    const bname = booking.name.trim().toLowerCase();
                    const allUsers = await db.execute('SELECT chat_id, first_name FROM telegram_users ORDER BY created_at DESC');
                    const nameMatch = allUsers.rows.find(r =>
                        (r.first_name || '').trim().toLowerCase() === bname &&
                        Number(r.chat_id) > 0 &&
                        r.chat_id !== '123456'
                    );
                    if (nameMatch) {
                        userChatId = nameMatch.chat_id;
                        await db.execute({ sql: 'UPDATE bookings SET telegram_chat_id = ? WHERE id = ?', args: [userChatId, bookingId] });
                    }
                } catch (e) { console.error('[DM] Name lookup error:', e.message); }
            }

            if (userChatId) {
                try {
                    await sendTelegram(token, userChatId, dmText);
                } catch (e) { console.error('[DM] Send error:', e.message); }
            } else {
                console.log('[DM] No chat_id for user:', booking.telegram_username);
            }
        }

        return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
};
