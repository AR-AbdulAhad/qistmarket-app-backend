require('dotenv').config();

const { sendOtp, sendGuarantorOtp } = require('../services/otpDispatcher');

// Guarantor OTP Confirmation (name present) and Purchaser Verification OTP
// (name absent) both route through otpDispatcher.js, so a single pair of
// .env flags — WATI_OTP_ENABLED / JAZZ_OTP_ENABLED — controls both the
// WhatsApp (WATI) and SMS (Jazz) channels for both flows.
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

  try {
    const result = name
      ? await sendGuarantorOtp(phone, name, code)
      : await sendOtp(phone, code);

    if (!result.success) {
      return res.status(502).json({
        success: false,
        error: 'Failed to send code. Please try again later.'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Code sent successfully.',
    });
  } catch (error) {
    console.error('sendCode error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to send code. Please try again later.'
    });
  }
};

module.exports = { sendCode };