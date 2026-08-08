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

  const username = process.env.SMARTPAY_USERNAME || 'test';
  const password = process.env.SMARTPAY_PASSWORD || 'test';

  let tokenResponse;
  try {
    const tokenReq = await fetch(SMARTPAY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const textResp = await tokenReq.text();
    try {
      tokenResponse = JSON.parse(textResp);
    } catch (err) {
      console.error('[smartPayGateway] Token response not JSON:', textResp);
      return { success: false, message: 'Payment gateway returned invalid token response' };
    }
  } catch (e) {
    console.error('[smartPayGateway] Token fetch error:', e);
    return { success: false, message: 'Failed to authenticate with Payment Gateway' };
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

  let dqrResponse;
  try {
    const dqrReq = await fetch(SMARTPAY_DQR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `${jwtToken}`,
      },
      body: JSON.stringify(payload),
    });
    const textResp = await dqrReq.text();
    try {
      dqrResponse = JSON.parse(textResp);
    } catch (err) {
      console.error('[smartPayGateway] DQR response not JSON:', textResp);
      return { success: false, message: 'Payment gateway returned invalid DQR response' };
    }
  } catch (e) {
    console.error('[smartPayGateway] DQR fetch error:', e);
    return { success: false, message: 'Failed to generate QR string from Gateway' };
  }

  if (dqrResponse?.statusCode !== '200' || !dqrResponse?.QrString) {
    return { success: false, message: 'Gateway refused to map the QR payload' };
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

  return { success: true, qrString, qrImageBase64 };
};

module.exports = { generateDqr };
