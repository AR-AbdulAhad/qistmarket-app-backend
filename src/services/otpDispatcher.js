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
 * each channel's failure is logged and does not affect the other.
 */
const sendOtp = async (phone, otp) => {
  const jobs = [];

  if (isWatiEnabled()) {
    jobs.push(
      Promise.resolve(watiService.sendOTP(phone, otp)).catch((err) => {
        console.error('[OTP] WATI send failed:', err?.message || err);
      })
    );
  }

  if (isJazzEnabled()) {
    jobs.push(
      jazzSmsService.sendOTPSms(phone, otp).catch((err) => {
        console.error('[OTP] Jazz send failed:', err?.message || err);
      })
    );
  }

  if (jobs.length === 0) {
    console.error('[OTP] No channel enabled — set WATI_OTP_ENABLED and/or JAZZ_OTP_ENABLED in .env');
    return;
  }

  await Promise.all(jobs);
};

module.exports = { sendOtp, isWatiEnabled, isJazzEnabled };
