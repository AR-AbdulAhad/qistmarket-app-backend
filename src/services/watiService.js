const axios = require('axios');
require('dotenv').config();

const WATI_ACCESS_TOKEN = process.env.WATI_ACCESS_TOKEN;
const WATI_TEMPLATE_NAME = process.env.WATI_TEMPLATE_NAME || 'otp_template';
const WATI_BROADCAST_NAME = process.env.WATI_BROADCAST_NAME || 'otp_broadcast';
const WATI_BASE_URL = process.env.WATI_BASE_URL;

const sendOTPWhatsApp = async (phone, otp) => {
  try {
    let whatsappNumber = phone;
    if (phone.startsWith('03') && phone.length === 11) {
      whatsappNumber = '+92' + phone.slice(1);
    } else if (!phone.startsWith('+')) {
      whatsappNumber = '+' + phone;
    }
    
    const url = `${WATI_BASE_URL}/api/v2/sendTemplateMessage`;
    
    const payload = {
      template_name: WATI_TEMPLATE_NAME,
      broadcast_name: WATI_BROADCAST_NAME,
      parameters: [{ 
        name: '1', 
        value: otp 
      }]
    };

    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${WATI_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      params: {
        whatsappNumber: whatsappNumber
      },
      timeout: 10000
    });

    if (response.data) {
      return { 
        success: true, 
        message: 'OTP sent successfully via WhatsApp',
        data: response.data 
      };
    } else {
      return { 
        success: true,
        message: 'OTP sent',
        data: response.data 
      };
    }

  } catch (error) {
    return { 
      success: false, 
      error: error.response?.data?.info || error.message || 'Failed to send OTP' 
    };
  }
};

const sendOTP = async (phone, otp) => {
  return sendOTPWhatsApp(phone, otp);
};

module.exports = { sendOTP };