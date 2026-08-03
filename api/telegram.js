const ALLOWED_ORIGIN = 'https://dash-akol.vercel.app';

function sanitize(str, maxLen = 100) {
    if (typeof str !== 'string') return '';
    return str.replace(/[<>&"']/g, '').trim().slice(0, maxLen);
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); } }

    const { name, phone, service, stylist, date, time, joke, booking_id } = body || {};
    if (!name || !phone || !service || !date || !time) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        return res.status(500).json({ error: 'Telegram not configured' });
    }

    const cleanName = sanitize(name, 50);
    const cleanPhone = sanitize(phone, 15);
    const cleanService = sanitize(service, 30);
    const cleanStylist = sanitize(stylist, 20);
    const cleanDate = sanitize(date, 40);
    const cleanTime = sanitize(time, 10);
    const cleanJoke = joke ? sanitize(joke, 60) : '';

    const text = ` Barber نوبت جدید — داش آکل

👤 نام: ${cleanName}
📱 تلفن: ${cleanPhone}
✂️ سرویس: ${cleanService}
💇 استایلیست: ${cleanStylist}
📅 تاریخ: ${cleanDate}
🕐 ساعت: ${cleanTime}
${cleanJoke ? `\n🎭 ${cleanJoke}` : ''}`;

    const inlineKeyboard = {
        inline_keyboard: [
            [
                { text: '✅ تایید نوبت', callback_data: `confirm_${booking_id || '0'}` },
                { text: '❌ رد نوبت', callback_data: `reject_${booking_id || '0'}` }
            ]
        ]
    };

    try {
        const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, reply_markup: inlineKeyboard })
        });
        const data = await tgRes.json();
        if (!data.ok) return res.status(502).json({ error: 'Telegram API error' });

        // Fetch bot username so the frontend can build a precise deep link
        let botUsername = null;
        try {
            const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
            const meData = await meRes.json();
            if (meData.ok && meData.result && meData.result.username) botUsername = meData.result.username;
        } catch {}

        return res.status(200).json({ success: true, message_id: data.result.message_id, bot_username: botUsername });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to send' });
    }
};
