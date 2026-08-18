const axios = require('axios');
require('dotenv').config();

const WATI_ACCESS_TOKEN = process.env.WATI_ACCESS_TOKEN;
const WATI_BASE_URL = process.env.WATI_BASE_URL;
const COMPLAINT_URL = 'https://app.qistmarket.pk/complaint';

// ─── Helpers ───────────────────────────────────────────────────────────────

const normalizePhone = (phone) => {
  if (!phone) return null;
  const p = phone.replace(/\s+/g, '').replace(/-/g, '');
  if (p.startsWith('03') && p.length === 11) return '+92' + p.slice(1);
  if (!p.startsWith('+')) return '+' + p;
  return p;
};

const sendTemplate = async (phone, templateName, broadcastName, parameters) => {
  try {
    const whatsappNumber = normalizePhone(phone);
    if (!whatsappNumber) return { success: false, error: 'Invalid phone number' };

    const url = `${WATI_BASE_URL}/api/v2/sendTemplateMessage`;
    const payload = {
      template_name: templateName,
      broadcast_name: broadcastName,
      parameters,
    };

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WATI_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      params: { whatsappNumber },
      timeout: 10000,
    });

    return { success: true, data: response.data };
  } catch (error) {
    console.error(`[WATI] Template "${templateName}" error:`, error.response?.data || error.message);
    return { success: false, error: error.response?.data?.info || error.message };
  }
};

// ─── OTP ───────────────────────────────────────────────────────────────────

const WATI_TEMPLATE_NAME = process.env.WATI_TEMPLATE_NAME || 'verifications_otp';
const WATI_BROADCAST_NAME = process.env.WATI_BROADCAST_NAME || 'verifications_otp';

const sendOTPWhatsApp = async (phone, otp) => {
  return sendTemplate(phone, WATI_TEMPLATE_NAME, WATI_BROADCAST_NAME, [
    { name: '1', value: otp },
  ]);
};

const sendOTP = async (phone, otp) => sendOTPWhatsApp(phone, otp);

// Grantor (guarantor) OTP — named template with the guarantor's name inserted,
// consolidated from what used to be duplicated inline in appVerificationOtp.js
// and ordersController.js's convert-sale grantor branch.
const WATI_GRANTORS_OTP_TEMPLATE = process.env.WATI_GRANTORS_OTP_TEMPLATE_NAME || 'grantors_otp';
const WATI_GRANTORS_OTP_BROADCAST = process.env.WATI_GRANTORS_OTP_BROADCAST_NAME || 'grantors_otp';

const sendGrantorOTP = async (phone, name, otp) => {
  return sendTemplate(phone, WATI_GRANTORS_OTP_TEMPLATE, WATI_GRANTORS_OTP_BROADCAST, [
    { name: '1', value: otp },
    { name: 'name', value: name || '' },
  ]);
};

// ─── Template 1: Delivery Confirmation ─────────────────────────────────────
// Params: customer_name, product_name, imei, color_variant, advance_amount,
//         delivery_date, order_ref, order_status

const WATI_DELIVERY_TEMPLATE = process.env.WATI_DELIVERY_CONFIRMATION_TEMPLATE || 'delivery_confirmation';
const WATI_DELIVERY_BROADCAST = process.env.WATI_DELIVERY_CONFIRMATION_TEMPLATE || 'delivery_confirmation';

const sendDeliveryConfirmation = async (phone, {
  customerName,
  productName,
  imei,
  colorVariant,
  advanceAmount,
  deliveryDate,
  orderRef,
  orderStatus,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: productName || 'N/A' },
    { name: '3', value: imei || 'N/A' },
    { name: '4', value: colorVariant || 'N/A' },
    { name: '5', value: String(advanceAmount || 0) },
    { name: '6', value: deliveryDate || new Date().toDateString() },
    { name: '7', value: orderRef || 'N/A' },
    { name: '8', value: orderStatus || 'Delivered' },
    { name: '9', value: COMPLAINT_URL },
  ];
  return sendTemplate(phone, WATI_DELIVERY_TEMPLATE, WATI_DELIVERY_BROADCAST, parameters);
};

// ─── Template 2: Return Confirmation ────────────────────────────────────────

const WATI_RETURN_TEMPLATE = process.env.WATI_RETURN_CONFIRMATION_TEMPLATE || 'return_confirmation';
const WATI_RETURN_BROADCAST = process.env.WATI_RETURN_CONFIRMATION_TEMPLATE || 'return_confirmation';

const sendReturnConfirmation = async (phone, {
  customerName,
  productName,
  orderRef,
  refundAmount,
  returnDate,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: productName || 'N/A' },
    { name: '3', value: orderRef || 'N/A' },
    { name: '4', value: String(refundAmount || 0) },
    { name: '5', value: returnDate || new Date().toDateString() },
  ];
  return sendTemplate(phone, WATI_RETURN_TEMPLATE, WATI_RETURN_BROADCAST, parameters);
};

// ─── Template 3: Installment Ledger ────────────────────────────────────────
// Params: customer_name, product_name, order_ref, next_month_label,
//         monthly_amount, due_date, total_remaining, ledger_url

const WATI_LEDGER_TEMPLATE = process.env.WATI_INSTALLMENT_LEDGER_TEMPLATE || 'installment_ledger';
const WATI_LEDGER_BROADCAST = process.env.WATI_INSTALLMENT_LEDGER_TEMPLATE || 'installment_ledger';

const sendInstallmentLedger = async (phone, {
  customerName,
  productName,
  orderRef,
  nextMonthLabel,
  monthlyAmount,
  dueDate,
  totalRemaining,
  ledgerUrl,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: productName || 'N/A' },
    { name: '3', value: orderRef || 'N/A' },
    { name: '4', value: nextMonthLabel || 'Mahina 1' },
    { name: '5', value: String(monthlyAmount || 0) },
    { name: '6', value: dueDate || 'N/A' },
    { name: '7', value: String(totalRemaining || 0) },
    { name: '8', value: ledgerUrl || 'N/A' },
    { name: '9', value: COMPLAINT_URL },
  ];
  return sendTemplate(phone, WATI_LEDGER_TEMPLATE, WATI_LEDGER_BROADCAST, parameters);
};

const WATI_PAYMENT_RECEIVED_TEMPLATE = process.env.WATI_INSTALLMENT_RECEIVED_TEMPLATE || 'installment_payment_receipt';
const WATI_PAYMENT_RECEIVED_BROADCAST = process.env.WATI_INSTALLMENT_RECEIVED_TEMPLATE || 'installment_payment_receipt';

const sendInstallmentPaymentReceipt = async (phone, {
  customerName,
  amount,
  productName,
  orderRef,
  date,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: String(amount || 0) },
    { name: '3', value: productName || 'N/A' },
    { name: '4', value: orderRef || 'N/A' },
    { name: '5', value: date || new Date().toDateString() },
    { name: '6', value: COMPLAINT_URL },
  ];
  return sendTemplate(phone, WATI_PAYMENT_RECEIVED_TEMPLATE, WATI_PAYMENT_RECEIVED_BROADCAST, parameters);
};

// ─── Template 3.1: Partial Installment Received ─────────────────────────────
const WATI_PARTIAL_PAYMENT_TEMPLATE = process.env.WATI_PARTIAL_PAYMENT_TEMPLATE || 'installment_partial_received';
const WATI_PARTIAL_PAYMENT_BROADCAST = process.env.WATI_PARTIAL_PAYMENT_TEMPLATE || 'installment_partial_received';

const sendPartialInstallmentPaymentReceipt = async (phone, {
  customerName,
  paidAmount,
  remainingAmount,
  productName,
  orderRef,
  dueDate,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: String(paidAmount || 0) },
    { name: '3', value: String(remainingAmount || 0) },
    { name: '4', value: productName || 'N/A' },
    { name: '5', value: orderRef || 'N/A' },
    { name: '6', value: dueDate || 'N/A' },
    { name: '7', value: COMPLAINT_URL },
  ];
  return sendTemplate(phone, WATI_PARTIAL_PAYMENT_TEMPLATE, WATI_PARTIAL_PAYMENT_BROADCAST, parameters);
};

// ─── Template 4: Next Month Reminder ──────────────────────────────────────
// Params: customer_name, product_name, monthly_amount, due_date, ledger_url
const WATI_REMINDER_TEMPLATE = process.env.WATI_INSTALLMENT_REMINDER_TEMPLATE || 'installment_reminder';
const WATI_REMINDER_BROADCAST = process.env.WATI_INSTALLMENT_REMINDER_TEMPLATE || 'installment_reminder';

const sendNextInstallmentReminder = async (phone, {
  customerName,
  productName,
  monthlyAmount,
  dueDate,
  ledgerUrl,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: productName || 'N/A' },
    { name: '3', value: String(monthlyAmount || 0) },
    { name: '4', value: dueDate || 'N/A' },
    { name: '5', value: ledgerUrl || 'N/A' },
    { name: '6', value: COMPLAINT_URL },
  ];
  return sendTemplate(phone, WATI_REMINDER_TEMPLATE, WATI_REMINDER_BROADCAST, parameters);
};

// ─── Template 5: Complaint Received ───────────────────────────────────────
const WATI_COMPLAINT_RECEIVED_TEMPLATE = process.env.WATI_COMPLAINT_RECEIVED_TEMPLATE || 'complaint_received';
const WATI_COMPLAINT_RECEIVED_BROADCAST = process.env.WATI_COMPLAINT_RECEIVED_TEMPLATE || 'complaint_received';

const sendComplaintReceived = async (phone, { customerName, complaintId }) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: complaintId || 'N/A' },
  ];
  return sendTemplate(phone, WATI_COMPLAINT_RECEIVED_TEMPLATE, WATI_COMPLAINT_RECEIVED_BROADCAST, parameters);
};

// ─── Template 6: Complaint Resolved ───────────────────────────────────────
const WATI_COMPLAINT_RESOLVED_TEMPLATE = process.env.WATI_COMPLAINT_RESOLVED_TEMPLATE || 'complaint_resolved';
const WATI_COMPLAINT_RESOLVED_BROADCAST = process.env.WATI_COMPLAINT_RESOLVED_TEMPLATE || 'complaint_resolved';

const sendComplaintResolved = async (phone, { customerName, complaintId, note }) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: complaintId || 'N/A' },
    { name: '3', value: note || 'Resolved gracefully' },
  ];
  return sendTemplate(phone, WATI_COMPLAINT_RESOLVED_TEMPLATE, WATI_COMPLAINT_RESOLVED_BROADCAST, parameters);
};

// ─── Template 7: Generic Order Status Update ─────────────────────────────
const WATI_ORDER_STATUS_TEMPLATE = process.env.WATI_ORDER_STATUS_TEMPLATE || 'order_status_update';
const WATI_ORDER_STATUS_BROADCAST = process.env.WATI_ORDER_STATUS_TEMPLATE || 'order_status_update';

const sendOrderStatusNotification = async (phone, { customerName, message }) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: message || 'Your order status has been updated.' },
  ];
  return sendTemplate(phone, WATI_ORDER_STATUS_TEMPLATE, WATI_ORDER_STATUS_BROADCAST, parameters);
};

// ─── Template 8: Promise To Pay (PTP) Confirmation ────────────────────────
// Params: customer_name, product_name, order_ref, promised_date, amount_due
const WATI_PTP_TEMPLATE = process.env.WATI_PTP_CONFIRMATION_TEMPLATE || 'ptp_confirmation';
const WATI_PTP_BROADCAST = process.env.WATI_PTP_CONFIRMATION_TEMPLATE || 'ptp_confirmation';

const sendPtpConfirmation = async (phone, {
  customerName,
  productName,
  orderRef,
  promisedDate,
  amountDue,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: productName || 'N/A' },
    { name: '3', value: orderRef || 'N/A' },
    { name: '4', value: promisedDate || 'N/A' },
    { name: '5', value: String(amountDue || 0) },
    { name: '6', value: COMPLAINT_URL },
  ];
  return sendTemplate(phone, WATI_PTP_TEMPLATE, WATI_PTP_BROADCAST, parameters);
};

// ─── Template 9: Order Booking Confirmation ────────────────────────────────
const WATI_ORDER_BOOKING_TEMPLATE = process.env.WATI_ORDER_BOOKING_TEMPLATE || 'order_booking_confirmation';
const WATI_ORDER_BOOKING_BROADCAST = process.env.WATI_ORDER_BOOKING_TEMPLATE || 'order_booking_confirmation';

const sendOrderBookingConfirmation = async (phone, {
  customerName,
  orderNumber,
  itemName,
  advanceAmount,
  installmentDuration,
  monthlyInstallment,
  orderBookerName,
  orderBookerNumber,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: orderNumber || 'N/A' },
    { name: '3', value: itemName || 'N/A' },
    { name: '4', value: String(advanceAmount || 0) },
    { name: '5', value: String(installmentDuration || 'N/A') },
    { name: '6', value: String(monthlyInstallment || 0) },
    { name: '7', value: orderBookerName || 'Qist Market' },
    { name: '8', value: orderBookerNumber || 'N/A' },
  ];
  // Note: the "Complaint Register Karein" link is a STATIC website button
  // configured in the WATI template itself, not a body variable — don't add
  // COMPLAINT_URL here, it would push the parameter count past the body's
  // {{1}}..{{8}} and cause WATI/Meta to reject the send.
  return sendTemplate(phone, WATI_ORDER_BOOKING_TEMPLATE, WATI_ORDER_BOOKING_BROADCAST, parameters);
};

// ─── Template 10: Order Transferred to Outlet ──────────────────────────────
const WATI_ORDER_TRANSFER_TEMPLATE = process.env.WATI_ORDER_TRANSFER_TEMPLATE || 'order_transfer_update';
const WATI_ORDER_TRANSFER_BROADCAST = process.env.WATI_ORDER_TRANSFER_TEMPLATE || 'order_transfer_update';

const sendOrderTransferUpdate = async (phone, {
  customerName,
  orderNumber,
  itemName,
  advanceAmount,
  installmentDuration,
  monthlyInstallment,
  outletName,
  frontDeskOfficerName,
  frontDeskOfficerNumber,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: orderNumber || 'N/A' },
    { name: '3', value: itemName || 'N/A' },
    { name: '4', value: String(advanceAmount || 0) },
    { name: '5', value: String(installmentDuration || 'N/A') },
    { name: '6', value: String(monthlyInstallment || 0) },
    { name: '7', value: outletName || 'N/A' },
    { name: '8', value: frontDeskOfficerName || 'N/A' },
    { name: '9', value: frontDeskOfficerNumber || 'N/A' },
  ];
  // Complaint link is a static website button on the template — no body variable for it.
  return sendTemplate(phone, WATI_ORDER_TRANSFER_TEMPLATE, WATI_ORDER_TRANSFER_BROADCAST, parameters);
};

// ─── Template 11: Verification Officer Assigned ────────────────────────────
const WATI_VERIFICATION_OFFICER_ASSIGNED_TEMPLATE = process.env.WATI_VERIFICATION_OFFICER_ASSIGNED_TEMPLATE || 'verification_officer_assigned';
const WATI_VERIFICATION_OFFICER_ASSIGNED_BROADCAST = process.env.WATI_VERIFICATION_OFFICER_ASSIGNED_TEMPLATE || 'verification_officer_assigned';

const sendVerificationOfficerAssigned = async (phone, {
  customerName,
  orderNumber,
  itemName,
  advanceAmount,
  installmentDuration,
  monthlyInstallment,
  outletName,
  verificationOfficerName,
  verificationOfficerNumber,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: orderNumber || 'N/A' },
    { name: '3', value: itemName || 'N/A' },
    { name: '4', value: String(advanceAmount || 0) },
    { name: '5', value: String(installmentDuration || 'N/A') },
    { name: '6', value: String(monthlyInstallment || 0) },
    { name: '7', value: outletName || 'N/A' },
    { name: '8', value: verificationOfficerName || 'N/A' },
    { name: '9', value: verificationOfficerNumber || 'N/A' },
  ];
  // Complaint link is a static website button on the template — no body variable for it.
  return sendTemplate(phone, WATI_VERIFICATION_OFFICER_ASSIGNED_TEMPLATE, WATI_VERIFICATION_OFFICER_ASSIGNED_BROADCAST, parameters);
};

// ─── Template 12: Verification Started ─────────────────────────────────────
const WATI_VERIFICATION_STARTED_TEMPLATE = process.env.WATI_VERIFICATION_STARTED_TEMPLATE || 'verification_started';
const WATI_VERIFICATION_STARTED_BROADCAST = process.env.WATI_VERIFICATION_STARTED_TEMPLATE || 'verification_started';

const sendVerificationStarted = async (phone, {
  customerName,
  orderNumber,
  itemName,
  advanceAmount,
  installmentDuration,
  monthlyInstallment,
  outletName,
  verificationOfficerName,
  verificationOfficerNumber,
  verificationStartDateTime,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: orderNumber || 'N/A' },
    { name: '3', value: itemName || 'N/A' },
    { name: '4', value: String(advanceAmount || 0) },
    { name: '5', value: String(installmentDuration || 'N/A') },
    { name: '6', value: String(monthlyInstallment || 0) },
    { name: '7', value: outletName || 'N/A' },
    { name: '8', value: verificationOfficerName || 'N/A' },
    { name: '9', value: verificationOfficerNumber || 'N/A' },
    { name: '10', value: verificationStartDateTime || new Date().toString() },
  ];
  // Complaint link is a static website button on the template — no body variable for it.
  return sendTemplate(phone, WATI_VERIFICATION_STARTED_TEMPLATE, WATI_VERIFICATION_STARTED_BROADCAST, parameters);
};

// ─── Template 13: Verification Completed ───────────────────────────────────
const WATI_VERIFICATION_COMPLETED_TEMPLATE = process.env.WATI_VERIFICATION_COMPLETED_TEMPLATE || 'verification_completed';
const WATI_VERIFICATION_COMPLETED_BROADCAST = process.env.WATI_VERIFICATION_COMPLETED_TEMPLATE || 'verification_completed';

const sendVerificationCompleted = async (phone, {
  customerName,
  orderNumber,
  itemName,
  advanceAmount,
  installmentDuration,
  monthlyInstallment,
  outletName,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: orderNumber || 'N/A' },
    { name: '3', value: itemName || 'N/A' },
    { name: '4', value: String(advanceAmount || 0) },
    { name: '5', value: String(installmentDuration || 'N/A') },
    { name: '6', value: String(monthlyInstallment || 0) },
    { name: '7', value: outletName || 'N/A' },
  ];
  return sendTemplate(phone, WATI_VERIFICATION_COMPLETED_TEMPLATE, WATI_VERIFICATION_COMPLETED_BROADCAST, parameters);
};

// ─── Template 14: Order Cancellation ───────────────────────────────────────
const WATI_ORDER_CANCELLATION_TEMPLATE = process.env.WATI_ORDER_CANCELLATION_TEMPLATE || 'order_cancellation_update';
const WATI_ORDER_CANCELLATION_BROADCAST = process.env.WATI_ORDER_CANCELLATION_TEMPLATE || 'order_cancellation_update';

const sendOrderCancellation = async (phone, {
  customerName,
  orderNumber,
  itemName,
  advanceAmount,
  installmentDuration,
  monthlyInstallment,
  outletName,
  cancelledByName,
  cancelledByRole,
  cancellationReason,
  cancellationDateTime,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: orderNumber || 'N/A' },
    { name: '3', value: itemName || 'N/A' },
    { name: '4', value: String(advanceAmount || 0) },
    { name: '5', value: String(installmentDuration || 'N/A') },
    { name: '6', value: String(monthlyInstallment || 0) },
    { name: '7', value: outletName || 'N/A' },
    { name: '8', value: cancelledByName || 'Qist Market' },
    { name: '9', value: cancelledByRole || 'N/A' },
    { name: '10', value: cancellationReason || 'N/A' },
    { name: '11', value: cancellationDateTime || new Date().toString() },
  ];
  return sendTemplate(phone, WATI_ORDER_CANCELLATION_TEMPLATE, WATI_ORDER_CANCELLATION_BROADCAST, parameters);
};

// ─── Template 15: Final Order Approval ──────────────────────────────────────
const WATI_FINAL_APPROVAL_TEMPLATE = process.env.WATI_FINAL_APPROVAL_TEMPLATE || 'final_order_approval';
const WATI_FINAL_APPROVAL_BROADCAST = process.env.WATI_FINAL_APPROVAL_TEMPLATE || 'final_order_approval';

const sendFinalOrderApproval = async (phone, {
  customerName,
  orderNumber,
  itemName,
  advanceAmount,
  installmentDuration,
  monthlyInstallment,
  outletName,
  decisionDateTime,
  analyzer1Name,
  analyzer1Decision,
  analyzer1Feedback,
  analyzer2Name,
  analyzer2Decision,
  analyzer2Feedback,
  thirdAnalyzerSection,
  frontDeskOfficerName,
  frontDeskOfficerNumber,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: orderNumber || 'N/A' },
    { name: '3', value: itemName || 'N/A' },
    { name: '4', value: String(advanceAmount || 0) },
    { name: '5', value: String(installmentDuration || 'N/A') },
    { name: '6', value: String(monthlyInstallment || 0) },
    { name: '7', value: outletName || 'N/A' },
    { name: '8', value: decisionDateTime || new Date().toString() },
    { name: '9', value: analyzer1Name || 'N/A' },
    { name: '10', value: analyzer1Decision || 'N/A' },
    { name: '11', value: analyzer1Feedback || 'N/A' },
    { name: '12', value: analyzer2Name || 'N/A' },
    { name: '13', value: analyzer2Decision || 'N/A' },
    { name: '14', value: analyzer2Feedback || 'N/A' },
    { name: '15', value: thirdAnalyzerSection || 'N/A' },
    { name: '16', value: frontDeskOfficerName || 'N/A' },
    { name: '17', value: frontDeskOfficerNumber || 'N/A' },
  ];
  // Complaint link is a static website button on the template — no body variable for it.
  return sendTemplate(phone, WATI_FINAL_APPROVAL_TEMPLATE, WATI_FINAL_APPROVAL_BROADCAST, parameters);
};

// ─── Template 16: Final Order Rejection ─────────────────────────────────────
const WATI_FINAL_REJECTION_TEMPLATE = process.env.WATI_FINAL_REJECTION_TEMPLATE || 'final_order_rejection';
const WATI_FINAL_REJECTION_BROADCAST = process.env.WATI_FINAL_REJECTION_TEMPLATE || 'final_order_rejection';

const sendFinalOrderRejection = async (phone, {
  customerName,
  orderNumber,
  itemName,
  advanceAmount,
  installmentDuration,
  monthlyInstallment,
  outletName,
  decisionDateTime,
  analyzer1Name,
  analyzer1Decision,
  analyzer1Feedback,
  analyzer2Name,
  analyzer2Decision,
  analyzer2Feedback,
  thirdAnalyzerSection,
  finalRejectionReason,
  frontDeskOfficerName,
  frontDeskOfficerNumber,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: orderNumber || 'N/A' },
    { name: '3', value: itemName || 'N/A' },
    { name: '4', value: String(advanceAmount || 0) },
    { name: '5', value: String(installmentDuration || 'N/A') },
    { name: '6', value: String(monthlyInstallment || 0) },
    { name: '7', value: outletName || 'N/A' },
    { name: '8', value: decisionDateTime || new Date().toString() },
    { name: '9', value: analyzer1Name || 'N/A' },
    { name: '10', value: analyzer1Decision || 'N/A' },
    { name: '11', value: analyzer1Feedback || 'N/A' },
    { name: '12', value: analyzer2Name || 'N/A' },
    { name: '13', value: analyzer2Decision || 'N/A' },
    { name: '14', value: analyzer2Feedback || 'N/A' },
    { name: '15', value: thirdAnalyzerSection || 'N/A' },
    { name: '16', value: finalRejectionReason || 'N/A' },
    { name: '17', value: frontDeskOfficerName || 'N/A' },
    { name: '18', value: frontDeskOfficerNumber || 'N/A' },
  ];
  // Complaint link is a static website button on the template — no body variable for it.
  return sendTemplate(phone, WATI_FINAL_REJECTION_TEMPLATE, WATI_FINAL_REJECTION_BROADCAST, parameters);
};

// ─── Broadcast helper — same template to multiple numbers ─────────────────
// Dedupes normalized numbers so the same WhatsApp doesn't get double messages.
const sendToMany = async (phones, sendFn) => {
  const seen = new Set();
  const results = [];
  for (const phone of phones) {
    const normalized = normalizePhone(phone);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    results.push(await sendFn(normalized));
  }
  return results;
};

// ─── Company notify numbers — from COMPANY_NOTIFY_PHONE (comma-separated) ─
const getCompanyNotifyPhones = () =>
  (process.env.COMPANY_NOTIFY_PHONE || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

module.exports = {
  sendTemplate,
  sendOTP,
  sendGrantorOTP,
  sendDeliveryConfirmation,
  sendReturnConfirmation,
  sendInstallmentLedger,
  sendInstallmentPaymentReceipt,
  sendPartialInstallmentPaymentReceipt,
  sendNextInstallmentReminder,
  sendComplaintReceived,
  sendComplaintResolved,
  sendOrderStatusNotification,
  sendPtpConfirmation,
  sendOrderBookingConfirmation,
  sendOrderTransferUpdate,
  sendVerificationOfficerAssigned,
  sendVerificationStarted,
  sendVerificationCompleted,
  sendOrderCancellation,
  sendFinalOrderApproval,
  sendFinalOrderRejection,
  sendToMany,
  getCompanyNotifyPhones,
};