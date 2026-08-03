const { createClient } = require('@libsql/client');

const ALLOWED_ORIGIN = 'https://dash-akol.vercel.app';
const RATE_LIMIT = new Map();

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

function isRateLimited(key, limit = 10, windowMs = 60000) {
    const now = Date.now();
    const entry = RATE_LIMIT.get(key);
    if (!entry || now - entry.start > windowMs) {
        RATE_LIMIT.set(key, { start: now, count: 1 });
        return false;
    }
    entry.count++;
    return entry.count > limit;
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
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();

    const token = process.env.TELEGRAM_BOT_TOKEN;

    // Debug GET — requires admin key
    if (req.method === 'GET') {
        const adminKey = req.headers['x-admin-key'] || req.query?.key;
        if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (isRateLimited('debug_' + adminKey, 10)) {
            return res.status(429).json({ error: 'Rate limited' });
        }
        const db = getClient();
        try {
            await db.execute(`CREATE TABLE IF NOT EXISTS telegram_users (chat_id TEXT PRIMARY KEY, username TEXT, first_name TEXT, phone TEXT, created_at TEXT DEFAULT (datetime('now')))`);
            await db.execute("DELETE FROM telegram_users WHERE chat_id = '123456'");
            const users = await db.execute('SELECT * FROM telegram_users ORDER BY created_at DESC');
            const bookings = await db.execute('SELECT id, date_key, time, name, phone, service, stylist, status, telegram_username FROM bookings ORDER BY id DESC LIMIT 10');
            return res.status(200).json({ users: users.rows, bookings: bookings.rows });
        } catch (e) {
            return res.status(500).json({ error: 'DB error' });
        }
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // Verify Telegram webhook secret
    const secretToken = req.headers['x-telegram-bot-api-secret-token'];
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret && secretToken !== expectedSecret) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); } }

    const db = getClient();
    await db.execute(`CREATE TABLE IF NOT EXISTS telegram_users (chat_id TEXT PRIMARY KEY, username TEXT, first_name TEXT, phone TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    await db.execute(`CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, date_key TEXT, time TEXT, name TEXT, phone TEXT, service TEXT, stylist TEXT, status TEXT DEFAULT 'pending', telegram_username TEXT, telegram_chat_id TEXT, telegram_message_id TEXT, link_code TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    try { await db.execute('ALTER TABLE telegram_users ADD COLUMN phone TEXT'); } catch {}

    // Handle incoming messages (any private message authenticates the user)
    if (body.message) {
        const msg = body.message;
        const rawChatId = msg.chat ? msg.chat.id : (msg.from ? msg.from.id : null);
        const chatId = Number(rawChatId);
        const isPrivate = chatId > 0;
        const text = msg.text || '';
        const username = (msg.from.username || '').replace(/^@/, '');
        const firstName = (msg.from.first_name || '').slice(0, 50);
        const personalId = String(msg.from.id);
        const phoneFromText = msg.contact && msg.contact.phone_number ? msg.contact.phone_number.replace(/\s+/g, '') : (text.trim().match(/^(\+?[\d\s\-]{10,15})$/) ? text.trim().replace(/[\s\-]/g, '') : '');

        try {
            // Preserve an already-stored phone when the new message has no phone
            const existing = await db.execute({ sql: 'SELECT phone FROM telegram_users WHERE chat_id = ?', args: [personalId] });
            const prevPhone = existing.rows.length ? existing.rows[0].phone : null;

            await db.execute({
                sql: 'INSERT OR REPLACE INTO telegram_users (chat_id, username, first_name, phone) VALUES (?, ?, ?, ?)',
                args: [personalId, username.slice(0, 30), firstName, phoneFromText || prevPhone || null]
            });

            // Precise linking via deep link: /start link_<code>
            const linkMatch = text.match(/^\/start\s+link_([a-f0-9]+)$/i);
            let linkMatched = false;
            if (linkMatch) {
                try {
                    const linkRes = await db.execute({ sql: 'UPDATE bookings SET telegram_chat_id = ? WHERE link_code = ? AND (telegram_chat_id IS NULL OR telegram_chat_id = ?)', args: [personalId, linkMatch[1], ''] });
                    linkMatched = linkRes.rowsAffected > 0;
                } catch (e) { console.error('[MSG] Link error:', e.message); }
            }

            // Auto-link pending bookings: first by phone, then by name
            const pending = await db.execute("SELECT id, name, phone FROM bookings WHERE (telegram_chat_id IS NULL OR telegram_chat_id = '')");
            for (const row of pending.rows) {
                const matchByPhone = phoneFromText && row.phone.replace(/\D/g, '').slice(-10) === phoneFromText.slice(-10);
                const matchByName = row.name.trim().toLowerCase() === (firstName || '').trim().toLowerCase();
                if (matchByPhone || matchByName) {
                    await db.execute({ sql: 'UPDATE bookings SET telegram_chat_id = ? WHERE id = ?', args: [personalId, row.id] });
                }
            }
        } catch (e) {
            console.error('[MSG] DB error:', e.message);
        }

        if (text === '/start' || linkMatched) {
            const replyTo = isPrivate ? chatId : personalId;
            try {
                const linkedNote = linkMatched ? '\n\nنوبتت وصل شد — تا تایید ادمین صبر کن، نتیجه رو همین‌جا بهت می‌گیم.' : '';
                await sendTelegram(token, replyTo, `سلام ${firstName}!\n\nبه بات داش آکل خوش اومدی.${linkedNote}\n\nروی دکمه زیر بزن تا وارد سایت بشی و نوبتت رو رزرو کنی.`, {
                    inline_keyboard: [[{ text: '💈 رزرو نوبت', url: 'https://dash-akol.vercel.app' }]]
                });
            } catch (e) {
                console.error('[/start] Reply error:', e.message);
            }
        } else if (isPrivate) {
            // Any other private message confirms authentication to the user
            try {
                await sendTelegram(token, personalId, `شناسایی شد ✅\n\nنوبتی با اسم «${firstName}» ثبت کرده بودی، همون اول که پیام دادی، وصل شد به حساب تلگرامت.\n\nهر وقت نوبتت تایید یا رد شه، همین‌جا خبرت می‌کنیم.`);
            } catch (e) {
                console.error('[MSG] Reply error:', e.message);
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
        const adminName = (cb.from.first_name || 'ادمین').slice(0, 50);

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

        try {
            await db.execute({ sql: 'UPDATE bookings SET status = ? WHERE id = ?', args: [newStatus, bookingId] });
        } catch (e) { console.error('[CB] Update error:', e.message); }

        let booking = null;
        try {
            const result = await db.execute({ sql: 'SELECT * FROM bookings WHERE id = ?', args: [bookingId] });
            if (result.rows.length > 0) booking = result.rows[0];
        } catch (e) { console.error('[CB] Select error:', e.message); }

        try {
            const newText = cb.message.text + `\n\n${statusEmoji} ${statusText} توسط ${adminName}`;
            await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: adminChatId, message_id: messageId, text: newText })
            });
        } catch (e) { console.error('[CB] Edit error:', e.message); }

        try {
            await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: cb.query_id, text: `نوبت ${statusText}` })
            });
        } catch (e) { console.error('[CB] Answer error:', e.message); }

        if (booking) {
            const dmText = `${statusEmoji} نوبت شما ${statusText}!\n\n📅 تاریخ: ${booking.date_key}\n🕐 ساعت: ${booking.time}\n✂️ سرویس: ${serviceNames[booking.service] || booking.service}\n\n${action === 'confirm' ? 'منتظرتون هستیم!' : 'متأسفیم، نوبت شما رد شد.'}`;

            let userChatId = null;

            // 1) Directly linked chat_id from when the user messaged the bot
            if (booking.telegram_chat_id && Number(booking.telegram_chat_id) > 0 && booking.telegram_chat_id !== '123456') {
                userChatId = booking.telegram_chat_id;
            }

            // 2) Match by phone number first
            if (!userChatId && booking.phone) {
                try {
                    const bphone = booking.phone.replace(/\D/g, '').slice(-10);
                    const allUsers = await db.execute('SELECT chat_id, phone, username, first_name FROM telegram_users');
                    const phoneMatch = allUsers.rows.find(r =>
                        r.phone && r.phone.replace(/\D/g, '').slice(-10) === bphone &&
                        Number(r.chat_id) > 0 && r.chat_id !== '123456'
                    );
                    if (phoneMatch) {
                        userChatId = phoneMatch.chat_id;
                        await db.execute({ sql: 'UPDATE bookings SET telegram_chat_id = ? WHERE id = ?', args: [userChatId, bookingId] });
                    }
                } catch (e) { console.error('[DM] Phone lookup error:', e.message); }
            }

            // 3) Match by name (exact, or first-word match)
            if (!userChatId && booking.name) {
                try {
                    const bname = booking.name.trim().toLowerCase();
                    const bFirst = bname.split(/\s+/)[0];
                    const allUsers = await db.execute('SELECT chat_id, first_name FROM telegram_users ORDER BY created_at DESC');
                    const nameMatch = allUsers.rows.find(r => {
                        const fn = (r.first_name || '').trim().toLowerCase();
                        if (!fn) return false;
                        return fn === bname || fn === bFirst || bname.includes(fn) || fn.includes(bFirst);
                    });
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
                // Tell the admin the customer couldn't be reached (they never messaged the bot)
                try {
                    const note = `${statusEmoji} نوبت ${statusText} شد ولی اطلاع‌رسانی مستقیم به مشتری ممکن نشد.\n\nبرای اینکه مشتری نتیجه نوبتش رو توی تلگرام بگیره، باید یه بار به بات داش آکل پیام بده.`;
                    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: adminChatId, text: note, reply_to_message_id: messageId })
                    });
                } catch (e) { console.error('[DM] Admin note error:', e.message); }
            }
        }

        return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
};
