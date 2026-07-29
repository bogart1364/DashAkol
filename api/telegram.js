module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); } }

    const { name, phone, service, stylist, date, time, joke, telegram_username, booking_id } = body || {};
    if (!name || !phone || !service || !date || !time) {
        return res.status(400).json({ error: 'Missing required fields', got: body });
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        return res.status(500).json({ error: 'Telegram not configured', hasToken: !!token, hasChatId: !!chatId });
    }

    const tgUser = telegram_username ? ` | @${telegram_username}` : '';
    const text = `💈 نوبت جدید — داش آکل

👤 نام: ${name}${tgUser}
📱 تلفن: ${phone}
✂️ سرویس: ${service}
💇 استایلیست: ${stylist}
📅 تاریخ: ${date}
🕐 ساعت: ${time}
${joke ? `\n🎭 ${joke}` : ''}`;

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
        if (!data.ok) return res.status(502).json({ error: 'Telegram API error', detail: data.description });
        return res.status(200).json({ success: true, message_id: data.result.message_id });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to send', detail: err.message });
    }
};
