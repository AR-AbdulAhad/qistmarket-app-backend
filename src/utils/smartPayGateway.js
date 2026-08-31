// Standalone SmartPay Token+DQR helper for the outlet bank-deposit QR flow
// (see bankAccountController.submitBankDeposit, qr_payment branch).
//
// Deliberately duplicated from smartPayController.generateSmartPayQr instead of
// extracting a shared function — that controller's flow is live and
// order/ledger-scoped; keeping this separate avoids any risk of regressing it.

const SMARTPAY_TOKEN_URL = 'https://smartpay.com.pk/services/api/v1/token';
const SMARTPAY_DQR_URL = 'https://smartpay.com.pk/services/api/v1/DQR';

/**
 * Generates a SmartPay QR for an arbitrary consumer number/detail/amount.
 * Returns { success: true, qrString, qrImageBase64 } or { success: false, message }.
 */
const generateDqr = async ({ consumerNumber, consumerDetail, amount, cellNo, referenceInfo }) => {
  const qrcode = require('qrcode');
  const t0 = Date.now();

  const username = process.env.SMARTPAY_USERNAME || 'test';
  const password = process.env.SMARTPAY_PASSWORD || 'test';

  let tokenResponse;
  try {
    const tokenReq = await fetch(SMARTPAY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      // Without a timeout, a slow/unresponsive gateway hangs this request past
      // the host's own reverse-proxy timeout, which then drops the connection
      // before we can respond — the browser sees this as a raw network error
      // with no message, instead of the real error/message this function
      // returns. Kept short so both calls combined (token + DQR below) still
      // finish comfortably inside whatever the hosting platform's own request
      // timeout is — shared/managed hosting (e.g. Hostinger's Node.js app via
      // Passenger) can have noticeably tighter limits than a typical VPS/
      // cloud reverse proxy, so err on the short side rather than assume a
      // generous window.
      signal: AbortSignal.timeout(6000),
    });
    console.log(`[smartPayGateway] Token call took ${Date.now() - t0}ms, status ${tokenReq.status}`);
    const textResp = await tokenReq.text();
    try {
      tokenResponse = JSON.parse(textResp);
    } catch (err) {
      console.error('[smartPayGateway] Token response not JSON:', textResp);
      return { success: false, message: 'Payment gateway returned invalid token response' };
    }
  } catch (e) {
    console.error(`[smartPayGateway] Token fetch error after ${Date.now() - t0}ms:`, e.name, e.message);
    return { success: false, message: e.name === 'TimeoutError' ? 'Payment Gateway timed out. Please try again.' : 'Failed to authenticate with Payment Gateway' };
  }

  if (tokenResponse?.statusCode !== '200' || !tokenResponse?.dist?.jwtToken) {
    return { success: false, message: 'Payment Gateway Authentication Failed' };
  }

  const jwtToken = tokenResponse.dist.jwtToken;

  const date = new Date();
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const billingMonth = `${yy}${mm}`;

  const payload = {
    Consumer_Number: consumerNumber,
    Consumer_Detail: consumerDetail || 'Customer',
    Billing_Month: billingMonth,
    Amount: parseFloat(amount).toFixed(2),
    CellNo: cellNo || '',
    EMail: '',
    ReferenceInfo: (referenceInfo || `QIST-${Date.now()}`).substring(0, 30),
    reserved: '',
  };

  // The DQR endpoint is the flaky one in practice (has been observed timing
  // out or returning an HTML error page instead of JSON), so it gets one
  // retry after a short pause — the token call above stays single-shot since
  // it's the lighter, more reliable of the two. Kept to 5s/attempt (not 6s)
  // so the worst case (2 attempts) plus the token call still fits comfortably
  // inside tight shared-hosting request timeouts.
  let dqrResponse;
  let dqrErrorMessage = 'Failed to generate QR string from Gateway';
  const dqrAttempts = 2;
  for (let attempt = 1; attempt <= dqrAttempts; attempt += 1) {
    const t1 = Date.now();
    try {
      const dqrReq = await fetch(SMARTPAY_DQR_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `${jwtToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      console.log(`[smartPayGateway] DQR call (attempt ${attempt}/${dqrAttempts}) took ${Date.now() - t1}ms, status ${dqrReq.status}`);
      const textResp = await dqrReq.text();
      try {
        dqrResponse = JSON.parse(textResp);
        break;
      } catch (err) {
        console.error(`[smartPayGateway] DQR response not JSON (attempt ${attempt}/${dqrAttempts}):`, textResp.slice(0, 300));
        dqrErrorMessage = 'Payment gateway returned invalid DQR response';
      }
    } catch (e) {
      console.error(`[smartPayGateway] DQR fetch error after ${Date.now() - t1}ms (attempt ${attempt}/${dqrAttempts}):`, e.name, e.message);
      dqrErrorMessage = e.name === 'TimeoutError' ? 'Payment Gateway timed out. Please try again.' : 'Failed to generate QR string from Gateway';
    }
    if (attempt < dqrAttempts) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!dqrResponse) {
    return { success: false, message: dqrErrorMessage };
  }

  if (dqrResponse?.statusCode !== '200' || !dqrResponse?.QrString) {
    console.error('[smartPayGateway] DQR rejected — full response:', JSON.stringify(dqrResponse));
    const gatewayReason = dqrResponse?.message || dqrResponse?.Message || dqrResponse?.error || dqrResponse?.statusDesc;
    return { success: false, message: gatewayReason ? `Payment Gateway: ${gatewayReason}` : 'Gateway refused to map the QR payload' };
  }

  const qrString = dqrResponse.QrString;

  let qrImageBase64 = '';
  try {
    qrImageBase64 = await qrcode.toDataURL(qrString, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 400,
    });
  } catch (e) {
    console.error('[smartPayGateway] QR image render error:', e);
    return { success: false, message: 'Failed to render QR Code image' };
  }

  console.log(`[smartPayGateway] generateDqr total took ${Date.now() - t0}ms`);
  return { success: true, qrString, qrImageBase64 };
};

module.exports = { generateDqr };
