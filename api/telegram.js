module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { name, phone, service, stylist, date, time, joke } = req.body;
    if (!name || !phone || !service || !date || !time) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        return res.status(500).json({ error: 'Telegram not configured' });
    }

    const text = `💈 نوبت جدید — داش آکل

👤 نام: ${name}
📱 تلفن: ${phone}
✂️ سرویس: ${service}
💇 استایلیست: ${stylist}
📅 تاریخ: ${date}
🕐 ساعت: ${time}
${joke ? `\n🎭 ${joke}` : ''}`;

    try {
        const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'UTF-8' })
        });
        const data = await tgRes.json();
        if (!data.ok) return res.status(502).json({ error: 'Telegram API error', detail: data.description });
        return res.status(200).json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to send', detail: err.message });
    }
};
