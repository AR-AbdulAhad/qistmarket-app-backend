const axios = require('axios');
require('dotenv').config();

const WATI_ACCESS_TOKEN = process.env.WATI_ACCESS_TOKEN;
const WATI_TEMPLATE_NAME = process.env.WATI_TEMPLATE_NAME;
const WATI_BROADCAST_NAME = process.env.WATI_BROADCAST_NAME;
const WATI_BASE_URL = process.env.WATI_BASE_URL;

const sendCode = async (req, res) => {
  const { code, phone, name } = req.body;

  if (!/^\d{5}$/.test(code)) {
    return res.status(400).json({
      success: false,
      error: 'Code must be a 5-digit number.'
    });
  }

  if (!/^03\d{9}$/.test(phone)) {
    return res.status(400).json({
      success: false,
      error: 'Phone must be an 11-digit Pakistani number starting with 03.'
    });
  }

  const whatsappNumber = '+92' + phone.slice(1);

  const url = `${WATI_BASE_URL}/api/v2/sendTemplateMessage?whatsappNumber=${whatsappNumber}`;

  let template_name = WATI_TEMPLATE_NAME;
  let broadcast_name = WATI_BROADCAST_NAME;
  const parameters = [{ name: '1', value: code }];

  if (name) {
    template_name = process.env.WATI_GRANTORS_OTP_TEMPLATE_NAME;
    broadcast_name = process.env.WATI_GRANTORS_OTP_BROADCAST_NAME;
    parameters.push({ name: 'name', value: name });
  }

  const payload = {
    template_name,
    broadcast_name,
    parameters
  };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${WATI_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    return res.status(200).json({
      success: true,
      message: 'Code sent successfully via WhatsApp.',
    });

  } catch (error) {
    console.error('Error sending template message:', error.message);

    let status = 500;
    let errorMessage = 'Failed to send code. Please try again later.';

    if (error.response) {
      status = error.response.status;
      errorMessage = error.response.data?.error ||
        error.response.data?.info ||
        'Wati API returned an error.';
    } else if (error.request) {
      errorMessage = 'No response from Wati server. Check network or base URL.';
    } else {
      errorMessage = error.message;
    }

    return res.status(status).json({
      success: false,
      error: errorMessage
    });
  }
};

module.exports = { sendCode };