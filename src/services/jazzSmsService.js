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

/** Guarantor OTP wrapper — mirrors the wording of the WATI "Guarantor OTP Confirmation" WhatsApp template. `name` is the purchaser's name (the person being guaranteed for), not the guarantor's own name — matches how the caller already passes it. This is the SHORT fallback used when order/officer context isn't available at the call site — see sendGuarantorOtpFullSms for the full, order-detail-rich version. */
const sendGuarantorOTPSms = async (phone, name, otp) => {
  const purchaserName = name || 'is customer';
  return sendSMS(
    phone,
    `Qist Market\nAssalam o Alaikum,\nAgar raqam receive na ho to item aur poori raqam ki zimmedari guarantee lene wale par hi hogi.\nAgar aap ${purchaserName} ki taraf se guarantee de rahe hain, to baraye meharbani yeh ${otp} foran hamare representative ko bata dein.\n\nShukriya Qist Market`
  );
};

/**
 * Full "Guarantor OTP Confirmation" SMS — the client's exact template text,
 * word for word, with every {{placeholder}} filled from real order data.
 * Used instead of sendGuarantorOTPSms when the caller has the order/officer
 * context on hand (see otpDispatcher.js's sendGuarantorOtp).
 */
const sendGuarantorOtpFullSms = async (phone, {
  guarantorName,
  customerName,
  orderNumber,
  itemNameModel,
  totalInstallmentPrice,
  advanceAmount,
  installmentDuration,
  monthlyInstallment,
  otp,
  frontDeskOfficerName,
  frontDeskOfficerNumber,
}) => {
  const message = `Assalam-o-Alaikum, ${guarantorName || 'Guarantor'}!

${customerName} ne Qist Market se qiston par item hasil karne ke liye aapko apna guarantor banaya hai.

Order Number: ${orderNumber}
Customer Name: ${customerName}
Item / Model: ${itemNameModel}
Total Installment Price: Rs. ${totalInstallmentPrice}
Advance Amount: Rs. ${advanceAmount}
Installment Plan: ${installmentDuration} Months
Monthly Installment: Rs. ${monthlyInstallment}

GUARANTOR KI ZIMMEDARI
Agar customer muqarara qist ya baqaya raqam ada nahi karta, to signed agreement aur Qist Market ki policy ke mutabiq item ki wapsi aur tamam baqaya raqam ki adaigi ki zimmedari app parhi hogi.

Agar aap tamam tafseelat aur zimmedariyan samajhne ke baad guarantee dene par razamand hain, to yeh code sirf darj-shuda representative ko bata dein:

CONFIRMATION CODE: ${otp}

OUTLET FRONT DESK OFFICER
Officer Name: ${frontDeskOfficerName || 'N/A'}
Contact Number: ${frontDeskOfficerNumber || 'N/A'}

ZAROORI HIDAYAT
Code share karna aapki razamandi aur guarantor banne ki tasdeeq samjha jayega. Agar aap customer ko nahi jaante, guarantee dene par razamand nahi hain ya details durust nahi hain, to code share na karein.`;

  return sendSMS(phone, message);
};

/**
 * Full "Purchaser Verification OTP" SMS — the client's exact template text,
 * word for word, with every {{placeholder}} filled from real order data.
 * There is no short fallback for this one (see otpDispatcher.js's sendOtp) —
 * sendOTPSms is used instead when order/officer context isn't available.
 */
const sendPurchaserVerificationOtpSms = async (phone, {
  customerName,
  orderNumber,
  itemNameModel,
  totalInstallmentPrice,
  advanceAmount,
  installmentDuration,
  monthlyInstallment,
  outletName,
  otp,
  verificationOfficerName,
  verificationOfficerNumber,
}) => {
  const message = `Assalam-o-Alaikum, ${customerName}!

Aapke Qist Market order ki verification jaari hai. Verification OTP share karne se pehle neeche di gayi tamam details ka ghour se jaiza lein.

Order Number: ${orderNumber}
Item / Model: ${itemNameModel}
Total Installment Price: Rs. ${totalInstallmentPrice}
Advance Amount: Rs. ${advanceAmount}
Installment Plan: ${installmentDuration} Months
Monthly Installment: Rs. ${monthlyInstallment}
Assigned Outlet: ${outletName}

Agar tamam details durust hain aur aap apni marzi se verification process mukammal karwana chahte hain, to yeh OTP sirf assigned Verification Officer ko bata dein:

VERIFICATION OTP: ${otp}

VERIFICATION OFFICER DETAILS
Officer Name: ${verificationOfficerName || 'N/A'}
Contact Number: ${verificationOfficerNumber || 'N/A'}

ZAROORI HIDAYAT
OTP share karna order details, item ki qeemat, advance amount aur installment plan ki tasdeeq samjha jayega. Agar koi detail ghalat ho to OTP share na karein aur pehle record durust karwayein.

Verification bilkul free hai. Verification ke naam par kisi ko koi raqam ada na karein. OTP share karne ya verification mukammal hone ka matlab order approve hona nahi hai; final approval mukammal jaizay ke baad di jayegi.`;

  return sendSMS(phone, message);
};

module.exports = {
  sendSMS,
  sendOTPSms,
  sendGuarantorOTPSms,
  sendGuarantorOtpFullSms,
  sendPurchaserVerificationOtpSms,
  isEnabled: () => JAZZ_CMT_ENABLED,
};
