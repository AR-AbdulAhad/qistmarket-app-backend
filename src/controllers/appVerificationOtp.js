const axios = require('axios');
require('dotenv').config();

const WATI_ACCESS_TOKEN = process.env.WATI_ACCESS_TOKEN;
const WATI_TEMPLATE_NAME = process.env.WATI_TEMPLATE_NAME;
const WATI_BROADCAST_NAME = process.env.WATI_BROADCAST_NAME;
const WATI_BASE_URL = process.env.WATI_BASE_URL;

const sendCode = async (req, res) => {
  const { code, phone } = req.body;

  if (!/^\d{5}$/.test(code)) {
    return res.status(400).json({ error: 'Code must be a 5-digit number.' });
  }

  if (!/^03\d{9}$/.test(phone)) {
    return res.status(400).json({ error: 'Phone must be an 11-digit Pakistani number starting with 03.' });
  }

  const whatsappNumber = '+92' + phone.slice(1);

  const url = `${WATI_BASE_URL}/api/v2/sendTemplateMessage?whatsappNumber=${whatsappNumber}`;

  const body = {
    template_name: WATI_TEMPLATE_NAME,
    broadcast_name: WATI_BROADCAST_NAME,
    parameters: [{ name: '1', value: code }]
  };

  await axios.post(url, body, {
    headers: {
      'Authorization': `Bearer ${WATI_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

module.exports = { sendCode };