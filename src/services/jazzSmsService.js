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

/**
 * Guarantor OTP wrapper — shortened to fit a single 160-char SMS segment.
 * `name` is the purchaser's name (the person being guaranteed for), not the
 * guarantor's own — matches how the caller already passes it. This is the
 * SHORT fallback used when order context isn't available at the call site —
 * see sendGuarantorOtpFullSms for the version with item/price.
 */
const sendGuarantorOTPSms = async (phone, name, otp) => {
  const purchaserName = name || 'is customer';
  const message = `${purchaserName} ke Qist order ke Guarantor ban rahe hain. Qist na bharne par zimmedari aap par hogi. Razamand to OTP rep ko batayein: ${otp}`;

  return sendSMS(phone, message);
};

/**
 * Full "Guarantor OTP Confirmation" SMS — shortened to fit a single 160-char
 * SMS segment, with every placeholder filled from real order data.
 * Used instead of sendGuarantorOTPSms when the caller has the order context
 * on hand (see otpDispatcher.js's sendGuarantorOtp). Sent when a guarantor
 * verifies via the mobile app (appVerificationOtp.js's sendCode).
 */
const sendGuarantorOtpFullSms = async (phone, {
  guarantorName,
  customerName,
  itemNameModel,
  price,
  otp,
}) => {
  const message = `${guarantorName || 'Guarantor'}, aap ${customerName} ke ${itemNameModel} (Rs.${price}) ki zimmedari lete hain. Qist na bharne par zimmedar honge. Razamand hain to OTP: ${otp}`;

  return sendSMS(phone, message);
};

/**
 * Full "Purchaser Verification OTP" SMS — shortened to fit a single 160-char
 * SMS segment, with every placeholder filled from real order data.
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
  const message = `${customerName}, order #${orderNumber} (${itemNameModel}) verify ho raha hai. Advance Rs.${advanceAmount}, ${installmentDuration}mo x Rs.${monthlyInstallment}. Sahi hai to OTP officer ${verificationOfficerName || 'N/A'} ko dein: ${otp}`;

  return sendSMS(phone, message);
};

/**
 * "Repeat Purchase Verification OTP" SMS — shortened to fit a single
 * 160-char SMS segment. For a RETURNING customer whose previous account is
 * already cleared, fast-tracked through the Convert-Sale flow
 * (ordersController.js's sendIndividualConvertOTP / createConvertedSale)
 * instead of the full physical re-verification sendPurchaserVerificationOtpSms
 * is used for.
 */
const sendRepeatPurchaseOtpSms = async (phone, {
  customerName,
  itemNameModel,
  orderRef,
  otp,
}) => {
  const message = `${customerName || 'Customer'}, purani profile clear hone ke baad ${itemNameModel || 'N/A'} (Ref ${orderRef || 'N/A'}) ke liye verification. OTP sirf authorized rep ko batayein: ${otp}`;

  return sendSMS(phone, message);
};

/**
 * "Item Handover" SMS — shortened to fit a single 160-char SMS segment.
 * Carries the delivery OTP the customer reads back to the delivery officer
 * at the doorstep handover — moved here from WATI (see watiService.js's
 * Template 20 comment); generateDeliveryOtp (deliveryController.js) still
 * validates the OTP through the existing saveOTP/verifyOTP('delivery') pair
 * unchanged, this only changes which channel carries it.
 */
const sendItemHandoverSms = async (phone, {
  customerName,
  itemName,
  advanceAmount,
  installmentAmount,
  installmentDate,
  totalInstallments,
  representativeName,
  representativeNumber,
  otp,
}) => {
  const message = `${customerName || 'Customer'}, ${itemName || 'N/A'} handover ho raha hai. Advance Rs.${advanceAmount || 0}, qist Rs.${installmentAmount || 0}/mahina x${totalInstallments ?? 'N/A'}. Razamand to OTP rep ${representativeName || 'N/A'} ko dein: ${otp}`;

  return sendSMS(phone, message);
};

module.exports = {
  sendSMS,
  sendOTPSms,
  sendGuarantorOTPSms,
  sendGuarantorOtpFullSms,
  sendPurchaserVerificationOtpSms,
  sendRepeatPurchaseOtpSms,
  sendItemHandoverSms,
  isEnabled: () => JAZZ_CMT_ENABLED,
};
