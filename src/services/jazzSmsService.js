const axios = require('axios');
require('dotenv').config();

// Jazz CMT (Mobilink Campaign Management Solution) — SMS gateway.
// Reference: docs/JAZZ_SMS_API.md (condensed from the vendor PDF).
// Uses the Direct (GET) API — simplest option, plain-text response, no XML.
//
// This is a SEPARATE, additive channel — it does not replace watiService.js
// (WhatsApp-based OTP). A Jazz send failure must never block or affect the
// WATI send; every function here fails soft (returns {success:false}, never
// throws) so a caller can fire-and-forget it alongside the existing flow.

const JAZZ_CMT_BASE_URL = process.env.JAZZ_CMT_BASE_URL || 'https://connect.jazzcmt.com';
const JAZZ_CMT_USERNAME = process.env.JAZZ_CMT_USERNAME;
const JAZZ_CMT_PASSWORD = process.env.JAZZ_CMT_PASSWORD;
const JAZZ_CMT_MASK = process.env.JAZZ_CMT_MASK;
// Fail-open-by-absence: if credentials aren't configured yet, sends are
// silently skipped rather than erroring — same pattern as PAYTRIGGER_ENABLED.
const JAZZ_CMT_ENABLED = process.env.JAZZ_CMT_ENABLED !== 'false'
  && Boolean(JAZZ_CMT_USERNAME && JAZZ_CMT_PASSWORD && JAZZ_CMT_MASK);

const SUCCESS_MESSAGE = 'Message Sent Successfully!';

// Jazz's Direct API expects local format (03XXXXXXXXX), not +92XXXXXXXXXX —
// normalize defensively in case a caller ever passes the +92 form.
const normalizePhone = (phone) => {
  if (!phone) return null;
  let p = String(phone).replace(/\s+/g, '').replace(/-/g, '');
  if (p.startsWith('+92')) p = '0' + p.slice(3);
  else if (p.startsWith('0092')) p = '0' + p.slice(4);
  else if (p.startsWith('92') && p.length === 12) p = '0' + p.slice(2);
  return /^03\d{9}$/.test(p) ? p : null;
};

/**
 * Send a single SMS via Jazz CMT's Direct API.
 * Returns { success, raw } on a real send attempt, or
 * { success: false, skipped: true } if Jazz isn't configured.
 */
const sendSMS = async (to, message) => {
  if (!JAZZ_CMT_ENABLED) {
    return { success: false, skipped: true, error: 'Jazz CMT not configured' };
  }

  const toNumber = normalizePhone(to);
  if (!toNumber) {
    return { success: false, error: 'Invalid phone number' };
  }

  try {
    const response = await axios.get(`${JAZZ_CMT_BASE_URL}/sendsms_url.html`, {
      params: {
        Username: JAZZ_CMT_USERNAME,
        Password: JAZZ_CMT_PASSWORD,
        From: JAZZ_CMT_MASK,
        To: toNumber,
        Message: message,
      },
      timeout: 10000,
    });

    const raw = typeof response.data === 'string' ? response.data.trim() : String(response.data);
    const success = raw.includes(SUCCESS_MESSAGE);
    if (!success) {
      console.error('[JazzSMS] send failed:', raw);
    }
    return { success, raw };
  } catch (error) {
    console.error('[JazzSMS] request error:', error.response?.data || error.message);
    return { success: false, error: error.response?.data || error.message };
  }
};

/** OTP-specific convenience wrapper — matches the wording already used elsewhere in the app. */
const sendOTPSms = async (phone, otp) => {
  return sendSMS(phone, `Your Qist Market verification code is ${otp}. Do not share this code with anyone.`);
};

/** Guarantor OTP wrapper — mirrors the wording of the WATI "Guarantor OTP Confirmation" WhatsApp template. `name` is the purchaser's name (the person being guaranteed for), not the guarantor's own name — matches how the caller already passes it. */
const sendGuarantorOTPSms = async (phone, name, otp) => {
  const purchaserName = name || 'is customer';
  return sendSMS(
    phone,
    `Qist Market\nAssalam o Alaikum,\nAgar raqam receive na ho to item aur poori raqam ki zimmedari guarantee lene wale par hi hogi.\nAgar aap ${purchaserName} ki taraf se guarantee de rahe hain, to baraye meharbani yeh ${otp} foran hamare representative ko bata dein.\n\nShukriya Qist Market`
  );
};

module.exports = {
  sendSMS,
  sendOTPSms,
  sendGuarantorOTPSms,
  isEnabled: () => JAZZ_CMT_ENABLED,
};
