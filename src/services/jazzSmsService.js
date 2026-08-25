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
 * Guarantor OTP wrapper — same wording/structure as sendGuarantorOtpFullSms,
 * minus the Item/Item Price lines (no order context to fill them with) and
 * the guarantor's own name in the greeting (only the purchaser's name is
 * passed to this short path). `name` is the purchaser's name (the person
 * being guaranteed for), not the guarantor's own — matches how the caller
 * already passes it. This is the SHORT fallback used when order context
 * isn't available at the call site — see sendGuarantorOtpFullSms for the
 * full, order-detail-rich version.
 */
const sendGuarantorOTPSms = async (phone, name, otp) => {
  const purchaserName = name || 'is customer';
  const message = `Assalam-o-Alaikum!

Aap ${purchaserName} ki Qist Market purchase ke liye Guarantor ban rahe hain.

Ahm Hidayat: Agar customer ki taraf se qist/raqam ada na ki jaye to item aur payable raqam ki zimmedari guarantor ki hogi, agreement ke mutabiq.

Agar aap is guarantee ke liye razamand hain to neeche diya gaya OTP Qist Market ke representative ko batayein. OTP batana aapki guarantor verification aur guarantee ki tasdeeq samjha jayega.

OTP: ${otp}

Complaint: https://qms.qistmarket.pk/complaint

Qist Market Har Cheez Qist Pe ..!!`;

  return sendSMS(phone, message);
};

/**
 * Full "Guarantor OTP Confirmation" SMS — the client's exact template text,
 * word for word, with every {{placeholder}} filled from real order data.
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
  const message = `Assalam-o-Alaikum ${guarantorName || 'Guarantor'}!

Aap ${customerName} ki Qist Market purchase ke liye Guarantor ban rahe hain.

Item: ${itemNameModel}
Item Price: ${price}

Ahm Hidayat: Agar customer ki taraf se qist/raqam ada na ki jaye to item aur payable raqam ki zimmedari guarantor ki hogi, agreement ke mutabiq.

Agar aap is guarantee ke liye razamand hain to neeche diya gaya OTP Qist Market ke representative ko batayein. OTP batana aapki guarantor verification aur guarantee ki tasdeeq samjha jayega.

OTP: ${otp}

Complaint: https://qms.qistmarket.pk/complaint

Qist Market Har Cheez Qist Pe ..!!`;

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

/**
 * "Repeat Purchase Verification OTP" SMS — the client's exact template text,
 * word for word. For a RETURNING customer whose previous account is already
 * cleared, fast-tracked through the Convert-Sale flow (ordersController.js's
 * sendIndividualConvertOTP / createConvertedSale) instead of the full
 * physical re-verification sendPurchaserVerificationOtpSms is used for.
 */
const sendRepeatPurchaseOtpSms = async (phone, {
  customerName,
  itemNameModel,
  orderRef,
  otp,
}) => {
  const message = `Assalam-o-Alaikum ${customerName || 'Customer'}!

Aapki purani profile ka account clear hone ke baad repeat purchase ke liye verification ki ja rahi hai.

New Item: ${itemNameModel || 'N/A'}
Application/Order Ref: ${orderRef || 'N/A'}

Aapki tasdeeq ke liye neeche OTP diya gaya hai. Meherbani karke OTP sirf Qist Market ke authorized representative ko batayein.

Customer OTP: ${otp}

OTP kisi ghair-mutaliqa shakhs ke saath share na karein.

Complaint: https://qms.qistmarket.pk/complaint
Qist Market Har Cheez Qist Pe ..!!`;

  return sendSMS(phone, message);
};

/**
 * "Item Handover" SMS — the client's exact template text, word for word.
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
  const message = `Assalam-o-Alaikum ${customerName || 'Customer'}!

Aapka item handover ho raha hai. Details check kar lein:

Item: ${itemName || 'N/A'}
Advance: Rs. ${advanceAmount || 0}
Installment: Rs. ${installmentAmount || 0}
Due Date: Har mahine ${installmentDate || 'N/A'}
Total Installments: ${totalInstallments ?? 'N/A'}

Razamand hain to OTP representative ko batayein.

Zaroori Hidayaat:
Installment na dene par device lock ho sakta hai.
Warranty sirf asli company ki terms par, Qist Market ka taalluq nahi.
Chori/damage par koi relief nahi; poori amount ada karni hogi.
Handover ke baad koi raqam wapas nahi hogi.
Item handover ke baad item wapas karne ki surat mein advance, installment ya kisi bhi ada ki hui raqam wapas nahi ki jayegi, jahan tak company ke terms & conditions lagu hon.

Shikayat ke liye OTP se pehle rabta karein.
Representative: ${representativeName || 'N/A'}
Contact: ${representativeNumber || 'N/A'}

Agar aap tamam details aur terms se razamand hain to yeh OTP batayein:

OTP: ${otp}

Shukriya, Qist Market — Har Cheez Qist Pe..!!

Complaint: https://qms.qistmarket.pk/complaint`;

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
