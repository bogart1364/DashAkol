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

async function answerCallback(token, callbackQueryId, text) {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: true })
    });
}

async function editMessage(token, chatId, messageId, text, replyMarkup) {
    const body = { chat_id: chatId, message_id: messageId, text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return res.json();
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return res.status(500).json({ error: 'No bot token' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); } }

    // Handle /start command
    if (body.message) {
        const msg = body.message;
        const chatId = msg.chat.id;
        const text = msg.text || '';
        const username = msg.from.username || '';
        const firstName = msg.from.first_name || '';

        if (text === '/start') {
            const db = getClient();
            try {
                await db.execute(`CREATE TABLE IF NOT EXISTS telegram_users (
                    chat_id TEXT PRIMARY KEY,
                    username TEXT,
                    first_name TEXT,
                    created_at TEXT DEFAULT (datetime('now'))
                )`);
                await db.execute({
                    sql: 'INSERT OR REPLACE INTO telegram_users (chat_id, username, first_name) VALUES (?, ?, ?)',
                    args: [String(chatId), username, firstName]
                });
                console.log('[START] Saved user:', chatId, username, firstName);
            } catch (e) {
                console.error('[START] DB error:', e.message);
            }

            await sendTelegram(token, chatId, `سلام ${firstName}! 👋

به بات داش آکل خوش اومدی.

وقتی نوبتت رو رزرو کنی، اینجا بهت خبر میدیم که نوبتت تایید شده یا نه.

فقط کافیه تو فرم رزرو، آیدی تلگرامت رو وارد کنی.`);
            return res.status(200).json({ ok: true });
        }

        // Store chat_id for any user who messages the bot
        if (username) {
            const db = getClient();
            try {
                await db.execute(`CREATE TABLE IF NOT EXISTS telegram_users (
                    chat_id TEXT PRIMARY KEY,
                    username TEXT,
                    first_name TEXT,
                    created_at TEXT DEFAULT (datetime('now'))
                )`);
                await db.execute({
                    sql: 'INSERT OR REPLACE INTO telegram_users (chat_id, username, first_name) VALUES (?, ?, ?)',
                    args: [String(chatId), username, firstName]
                });
                console.log('[MSG] Saved user:', chatId, username);
            } catch (e) {
                console.error('[MSG] DB error:', e.message);
            }
        }

        return res.status(200).json({ ok: true });
    }

    // Handle callback query (button clicks)
    if (body.callback_query) {
        const cb = body.callback_query;
        const data = cb.data || '';
        const chatId = cb.message.chat.id;
        const messageId = cb.message.message_id;
        const adminName = cb.from.first_name || 'ادمین';

        const db = getClient();

        // Parse callback data: confirm_123 or reject_123
        const match = data.match(/^(confirm|reject)_(\d+)$/);
        if (!match) {
            await answerCallback(token, cb.query_id, 'دکمه نامعتبر!');
            return res.status(200).json({ ok: true });
        }

        const action = match[1];
        const bookingId = parseInt(match[2]);
        const newStatus = action === 'confirm' ? 'confirmed' : 'rejected';
        const statusEmoji = action === 'confirm' ? '✅' : '❌';
        const statusText = action === 'confirm' ? 'تایید شد' : 'رد شد';

        // Update booking status in DB
        try {
            await db.execute({ sql: 'UPDATE bookings SET status = ? WHERE id = ?', args: [newStatus, bookingId] });
        } catch {}

        // Get booking details
        let booking = null;
        try {
            const result = await db.execute({ sql: 'SELECT * FROM bookings WHERE id = ?', args: [bookingId] });
            if (result.rows.length > 0) booking = result.rows[0];
        } catch {}

        // Edit the original message to show status
        const newText = cb.message.text + `\n\n${statusEmoji} ${statusText} توسط ${adminName}`;
        await editMessage(token, chatId, messageId, newText);

        // Answer the callback
        await answerCallback(token, cb.query_id, `نوبت ${statusText}`);

        // Send DM to user if they have a chat_id stored
        if (booking && booking.telegram_chat_id) {
            const userChatId = booking.telegram_chat_id;
            const serviceNames = { hair: 'اصلاح مو', beard: 'فرم دهی ریش', classic: 'اصلاح کلاسیک', texturize: 'پیتاژ', full: 'پکیج مرد کامل', groom: 'پکیج داماد' };
            const userMsg = `${statusEmoji} نوبت شما ${statusText}!

📅 تاریخ: ${booking.date_key}
🕐 ساعت: ${booking.time}
✂️ سرویس: ${serviceNames[booking.service] || booking.service}

${action === 'confirm'
    ? 'منتظرتون هستیم! 🤝'
    : 'متأسفیم، نوبت شما رد شد. لطفاً وقت دیگه‌ای رزرو کنید.'}`;

            const dmResult = await sendTelegram(token, userChatId, userMsg);
            console.log('[DM] Sent to chat_id:', userChatId, 'result:', JSON.stringify(dmResult));
        } else if (booking && booking.telegram_username) {
            // Try to find chat_id from telegram_users table (case-insensitive)
            try {
                const uname = booking.telegram_username.toLowerCase();
                console.log('[DM] Looking up username:', uname);
                const result = await db.execute({ sql: 'SELECT chat_id, username FROM telegram_users', args: [] });
                console.log('[DM] All telegram_users:', JSON.stringify(result.rows));
                
                const found = result.rows.find(r => (r.username || '').toLowerCase() === uname);
                if (found) {
                    const userChatId = found.chat_id;
                    console.log('[DM] Found user:', userChatId, found.username);
                    const serviceNames = { hair: 'اصلاح مو', beard: 'فرم دهی ریش', classic: 'اصلاح کلاسیک', texturize: 'پیتاژ', full: 'پکیج مرد کامل', groom: 'پکیج داماد' };
                    const userMsg = `${statusEmoji} نوبت شما ${statusText}!

📅 تاریخ: ${booking.date_key}
🕐 ساعت: ${booking.time}
✂️ سرویس: ${serviceNames[booking.service] || booking.service}

${action === 'confirm'
    ? 'منتظرتون هستیم! 🤝'
    : 'متأسفیم، نوبت شما رد شد. لطفاً وقت دیگه‌ای رزرو کنید.'}`;

                    const dmResult = await sendTelegram(token, userChatId, userMsg);
                    console.log('[DM] Sent result:', JSON.stringify(dmResult));

                    // Store chat_id for future use
                    await db.execute({ sql: 'UPDATE bookings SET telegram_chat_id = ? WHERE id = ?', args: [userChatId, bookingId] });
                } else {
                    console.log('[DM] User not found for username:', uname);
                }
            } catch (e) {
                console.error('[DM] Error:', e.message);
            }
        } else {
            console.log('[DM] No chat_id or username for booking:', bookingId);
        }

        return res.status(200).json({ ok: true });
    }

    // Debug GET — check telegram_users table
    if (req.method === 'GET') {
        const db = getClient();
        try {
            await db.execute(`CREATE TABLE IF NOT EXISTS telegram_users (
                chat_id TEXT PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )`);
            const users = await db.execute('SELECT * FROM telegram_users');
            return res.status(200).json({ users: users.rows });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    return res.status(200).json({ ok: true });
};
