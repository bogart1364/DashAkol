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

async function sendTelegram(token, chatId, text, replyMarkup) {
    const body = { chat_id: chatId, text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await res.json();
    return { ok: data && data.ok, error_code: data && data.error_code, description: data && data.description };
}

async function answerCb(token, queryId, text) {
    try {
        await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: queryId, text })
        });
    } catch {}
}

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();

    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (req.method === 'GET') {
        return res.status(200).json({ ok: true, msg: 'webhook alive' });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const secretToken = req.headers['x-telegram-bot-api-secret-token'];
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret && secretToken !== expectedSecret) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    let body = req.body;
    if (!body) {
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString();
            body = JSON.parse(raw);
        } catch {
            return res.status(200).json({ ok: true });
        }
    }
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { return res.status(200).json({ ok: true }); }
    }

    if (!body) return res.status(200).json({ ok: true });

    const db = getClient();
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS telegram_users (chat_id TEXT PRIMARY KEY, username TEXT, first_name TEXT, phone TEXT, created_at TEXT DEFAULT (datetime('now')))`);
        await db.execute(`CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, date_key TEXT, time TEXT, name TEXT, phone TEXT, service TEXT, stylist TEXT, status TEXT DEFAULT 'pending', telegram_username TEXT, telegram_chat_id TEXT, telegram_message_id TEXT, link_code TEXT, created_at TEXT DEFAULT (datetime('now')))`);
        try { await db.execute('ALTER TABLE telegram_users ADD COLUMN phone TEXT'); } catch {}
    } catch (e) {
        console.error('[WEBHOOK] DB init:', e.message);
        return res.status(200).json({ ok: true });
    }

    try {
        if (body.message) {
            const msg = body.message;
            const chatId = Number(msg.chat ? msg.chat.id : (msg.from ? msg.from.id : 0));
            const isPrivate = chatId > 0;
            const text = msg.text || '';
            const firstName = ((msg.from && msg.from.first_name) || '').slice(0, 50);
            const personalId = String((msg.from && msg.from.id) || chatId);
            const phoneFromText = msg.contact && msg.contact.phone_number
                ? msg.contact.phone_number.replace(/\s+/g, '')
                : '';

            let linkMatched = false;

            try {
                const existing = await db.execute({ sql: 'SELECT phone FROM telegram_users WHERE chat_id = ?', args: [personalId] });
                const prevPhone = existing.rows.length ? existing.rows[0].phone : null;
                const username = ((msg.from && msg.from.username) || '').replace(/^@/, '');

                await db.execute({
                    sql: 'INSERT OR REPLACE INTO telegram_users (chat_id, username, first_name, phone) VALUES (?, ?, ?, ?)',
                    args: [personalId, username.slice(0, 30), firstName, phoneFromText || prevPhone || null]
                });

                const linkMatch = text.match(/^\/start\s+link_([a-f0-9]+)$/i);
                if (linkMatch) {
                    try {
                        const linkRes = await db.execute({ sql: 'UPDATE bookings SET telegram_chat_id = ? WHERE link_code = ? AND (telegram_chat_id IS NULL OR telegram_chat_id = ?)', args: [personalId, linkMatch[1], ''] });
                        linkMatched = linkRes.rowsAffected > 0;
                    } catch (e) { console.error('[MSG] Link:', e.message); }
                }

                try {
                    const pending = await db.execute("SELECT id, name, phone FROM bookings WHERE (telegram_chat_id IS NULL OR telegram_chat_id = '')");
                    for (const row of pending.rows) {
                        const mp = phoneFromText && row.phone && row.phone.replace(/\D/g, '').slice(-10) === phoneFromText.slice(-10);
                        const mn = row.name && firstName && row.name.trim().toLowerCase() === firstName.trim().toLowerCase();
                        if (mp || mn) {
                            await db.execute({ sql: 'UPDATE bookings SET telegram_chat_id = ? WHERE id = ?', args: [personalId, row.id] });
                        }
                    }
                } catch (e) { console.error('[MSG] AutoLink:', e.message); }
            } catch (e) { console.error('[MSG] DB:', e.message); }

            if (text === '/start' || linkMatched) {
                const replyTo = isPrivate ? chatId : personalId;
                try {
                    const linkedNote = linkMatched ? '\n\nنوبتت وصل شد — تا تایید ادمین صبر کن.' : '';
                    await sendTelegram(token, replyTo, `سلام ${firstName}!\n\nبه بات داش آکل خوش اومدی.${linkedNote}\n\nروی دکمه زیر بزن تا وارد سایت بشی و نوبتت رو رزرو کنی.`, {
                        inline_keyboard: [[{ text: '💈 رزرو نوبت', url: 'https://dash-akol.vercel.app' }]]
                    });
                } catch (e) { console.error('[/start] Send:', e.message); }
            } else if (isPrivate) {
                try {
                    await sendTelegram(token, chatId, `شناسایی شد.\n\nهر وقت نوبتت تایید یا رد شه، همین‌جا خبرت می‌کنیم.`);
                } catch (e) { console.error('[MSG] Send:', e.message); }
            }

            return res.status(200).json({ ok: true });
        }

        if (body.callback_query) {
            const cb = body.callback_query;
            const data = cb.data || '';

            if (!cb.message) {
                await answerCb(token, cb.query_id, 'خطا!');
                return res.status(200).json({ ok: true });
            }

            const adminChatId = cb.message.chat.id;
            const messageId = cb.message.message_id;
            const adminName = ((cb.from && cb.from.first_name) || 'ادمین').slice(0, 50);

            const match = data.match(/^(confirm|reject)_(\d+)$/);
            if (!match) {
                await answerCb(token, cb.query_id, 'دکمه نامعتبر!');
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
            } catch (e) { console.error('[CB] Update:', e.message); }

            let booking = null;
            try {
                const result = await db.execute({ sql: 'SELECT * FROM bookings WHERE id = ?', args: [bookingId] });
                if (result.rows.length > 0) booking = result.rows[0];
            } catch (e) { console.error('[CB] Select:', e.message); }

            try {
                const newText = (cb.message.text || '') + `\n\n${statusEmoji} ${statusText} توسط ${adminName}`;
                await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: adminChatId, message_id: messageId, text: newText })
                });
            } catch (e) { console.error('[CB] Edit:', e.message); }

            await answerCb(token, cb.query_id, `نوبت ${statusText}`);

            if (booking) {
                const dmText = `${statusEmoji} نوبت شما ${statusText}!\n\n📅 تاریخ: ${booking.date_key}\n🕐 ساعت: ${booking.time}\n✂️ سرویس: ${serviceNames[booking.service] || booking.service}\n\n${action === 'confirm' ? 'منتظرتون هستیم!' : 'متأسفیم، نوبت شما رد شد.'}`;

                let userChatId = null;

                if (booking.telegram_chat_id && Number(booking.telegram_chat_id) > 0 && booking.telegram_chat_id !== '123456') {
                    userChatId = booking.telegram_chat_id;
                }

                if (!userChatId && booking.phone) {
                    try {
                        const bphone = booking.phone.replace(/\D/g, '').slice(-10);
                        const allUsers = await db.execute('SELECT chat_id, phone FROM telegram_users');
                        const phoneMatch = allUsers.rows.find(r =>
                            r.phone && r.phone.replace(/\D/g, '').slice(-10) === bphone &&
                            Number(r.chat_id) > 0 && r.chat_id !== '123456'
                        );
                        if (phoneMatch) {
                            userChatId = phoneMatch.chat_id;
                            await db.execute({ sql: 'UPDATE bookings SET telegram_chat_id = ? WHERE id = ?', args: [userChatId, bookingId] });
                        }
                    } catch (e) { console.error('[DM] Phone:', e.message); }
                }

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
                    } catch (e) { console.error('[DM] Name:', e.message); }
                }

                if (userChatId) {
                    const dmResult = await sendTelegram(token, userChatId, dmText);
                    if (!dmResult.ok) {
                        const err = (dmResult.description || '').toLowerCase();
                        let reason = 'اطلاع‌رسانی به مشتری ممکن نشد.';
                        if (err.includes('initiate') || err.includes('cannot') || err.includes('kick')) {
                            reason = 'مشتری هنوز روی استارت ربات نزده.';
                        } else if (err.includes('blocked')) {
                            reason = 'مشتری ربات رو بلاک کرده.';
                        } else if (dmResult.error_code === 429) {
                            reason = 'ارسال زیاد شد؛ دوباره امتحان کن.';
                        }
                        try {
                            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chat_id: adminChatId, text: `${statusEmoji} ${reason}`, reply_to_message_id: messageId })
                            });
                        } catch {}
                    }
                } else {
                    try {
                        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: adminChatId, text: `${statusEmoji} نوبت ${statusText} شد ولی مشتری به بات پیام نداده.`, reply_to_message_id: messageId })
                        });
                    } catch {}
                }
            }

            return res.status(200).json({ ok: true });
        }

        return res.status(200).json({ ok: true });
    } catch (e) {
        console.error('[WEBHOOK] Fatal:', e.message, e.stack);
        return res.status(200).json({ ok: true });
    }
};
