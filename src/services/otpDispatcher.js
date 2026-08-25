const watiService = require('./watiService');
const jazzSmsService = require('./jazzSmsService');
require('dotenv').config();

// Central OTP dispatch point — every OTP-sending call site in the app (login,
// web login, stock transfer, delivery/return OTPs, ledger access, etc.)
// imports `sendOtp` from here instead of watiService directly, so a single
// pair of .env flags controls all of them at once, with no code change
// needed to switch providers.
//
//   WATI_OTP_ENABLED=true/false   — WhatsApp OTP via WATI  (default: true)
//   JAZZ_OTP_ENABLED=true/false   — SMS OTP via Jazz CMT    (default: false)
//
// Both true  -> OTP sent via both channels.
// Only one true -> OTP sent via that channel only.
// Both false -> nothing is sent (logged as a misconfiguration, not thrown).

const isWatiEnabled = () => process.env.WATI_OTP_ENABLED !== 'false';
const isJazzEnabled = () => process.env.JAZZ_OTP_ENABLED === 'true';

/**
 * Sends an OTP via whichever channel(s) are enabled in .env. Never throws —
 * each channel's failure is logged and does not affect the other. Resolves to
 * { success, wati, jazz } so a caller that needs to know whether the OTP
 * actually went out (e.g. an HTTP endpoint reporting failure to the app) can
 * check it; fire-and-forget callers can simply ignore the return value.
 *
 * `context`, when provided (order/officer details — see appVerificationOtp.js
 * for the shape), switches the Jazz SMS from the generic short OTP text to
 * the client's full "Purchaser Verification OTP" template. WATI is
 * unaffected either way — this only changes the SMS channel.
 */
// Dev convenience: print the OTP straight to the terminal so it can be typed
// in during local testing without waiting on a real WhatsApp/SMS delivery.
// Never runs in production — an OTP in server logs would be a security hole.
const logOtpForDev = (phone, otp) => {
  if (process.env.NODE_ENV === 'production') return;
  console.log(`[OTP][DEV] ${phone} -> ${otp}`);
};

const sendOtp = async (phone, otp, context = null) => {
  logOtpForDev(phone, otp);
  const result = { success: false, wati: null, jazz: null };

  if (isWatiEnabled()) {
    result.wati = await Promise.resolve(watiService.sendOTP(phone, otp)).catch((err) => {
      console.error('[OTP] WATI send failed:', err?.message || err);
      return { success: false, error: err?.message || String(err) };
    });
  }

  if (isJazzEnabled()) {
    result.jazz = await (context
      ? jazzSmsService.sendPurchaserVerificationOtpSms(phone, { ...context, otp })
      : jazzSmsService.sendOTPSms(phone, otp)
    ).catch((err) => {
      console.error('[OTP] Jazz send failed:', err?.message || err);
      return { success: false, error: err?.message || String(err) };
    });
  }

  if (!result.wati && !result.jazz) {
    console.error('[OTP] No channel enabled — set WATI_OTP_ENABLED and/or JAZZ_OTP_ENABLED in .env');
    return result;
  }

  result.success = Boolean(result.wati?.success || result.jazz?.success);
  return result;
};

/**
 * Same as sendOtp, but for the named "guarantor" OTP flow — uses the WATI
 * grantor-specific template (with the guarantor's name) unchanged, and on
 * Jazz either the condensed guarantor-worded SMS (no context) or the full
 * "Guarantor OTP Confirmation" template (context provided — see
 * appVerificationOtp.js for the shape). Gated by the same WATI_OTP_ENABLED /
 * JAZZ_OTP_ENABLED flags as the generic OTP so both flows switch together.
 */
const sendGuarantorOtp = async (phone, name, otp, context = null) => {
  logOtpForDev(phone, otp);
  const result = { success: false, wati: null, jazz: null };

  if (isWatiEnabled()) {
    result.wati = await Promise.resolve(watiService.sendGrantorOTP(phone, name, otp)).catch((err) => {
      console.error('[OTP] WATI guarantor send failed:', err?.message || err);
      return { success: false, error: err?.message || String(err) };
    });
  }

  if (isJazzEnabled()) {
    result.jazz = await (context
      ? jazzSmsService.sendGuarantorOtpFullSms(phone, { ...context, otp })
      : jazzSmsService.sendGuarantorOTPSms(phone, name, otp)
    ).catch((err) => {
      console.error('[OTP] Jazz guarantor send failed:', err?.message || err);
      return { success: false, error: err?.message || String(err) };
    });
  }

  if (!result.wati && !result.jazz) {
    console.error('[OTP] No channel enabled — set WATI_OTP_ENABLED and/or JAZZ_OTP_ENABLED in .env');
    return result;
  }

  result.success = Boolean(result.wati?.success || result.jazz?.success);
  return result;
};

module.exports = { sendOtp, sendGuarantorOtp, isWatiEnabled, isJazzEnabled };
