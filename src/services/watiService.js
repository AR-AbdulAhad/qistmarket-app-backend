const axios = require('axios');
require('dotenv').config();

const WATI_ACCESS_TOKEN = process.env.WATI_ACCESS_TOKEN;
const WATI_BASE_URL = process.env.WATI_BASE_URL;
const COMPLAINT_URL = 'https://app.qistmarket.pk/complaint';
const QIST_BRANCH_CONTACT_NUMBER = '021-111-11-7747';

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
// This template uses named body variables ({{Customer_Name}}, {{Item_Name_Model}}, ...)
// plus one named *button* variable ({{Ledger_Link}}, filling the dynamic URL
// https://api.qistmarket.pk/ledger/{{Ledger_Link}}) — confirmed against the live
// WATI template via GET /api/v1/getMessageTemplates. WATI matches every parameter
// by its `name` against body AND button placeholders in one flat list, so
// Ledger_Link belongs in this same array, not a separate buttons payload.

const WATI_DELIVERY_TEMPLATE = process.env.WATI_DELIVERY_CONFIRMATION_TEMPLATE || 'delivery_confirmation';
const WATI_DELIVERY_BROADCAST = process.env.WATI_DELIVERY_CONFIRMATION_TEMPLATE || 'delivery_confirmation';

const sendDeliveryConfirmation = async (phone, {
  customerName,
  productName,
  imei,
  advanceAmount,
  deliveryDate,
  orderRef,
  orderStatus,
  deliveredByName,
  deliveredByNumber,
  branchName,
  branchCode,
  totalInstallmentPrice,
  installmentDuration,
  monthlyInstallment,
  nextDueDate,
  remainingAmount,
  ledgerUrl,
}) => {
  const parameters = [
    { name: 'Customer_Name', value: customerName || 'Customer' },
    { name: 'Item_Name_Model', value: productName || 'N/A' },
    { name: 'IMEI_Serial', value: imei || 'N/A' },
    { name: 'Advance_Amount', value: String(advanceAmount || 0) },
    { name: 'Delivery_Date', value: deliveryDate || new Date().toDateString() },
    { name: 'Order_Number', value: orderRef || 'N/A' },
    { name: 'Delivery_Type', value: orderStatus || 'Delivered' },
    { name: 'Delivered_By_Name', value: deliveredByName || 'N/A' },
    { name: 'Delivered_By_Number', value: deliveredByNumber || 'N/A' },
    { name: 'Branch_Name', value: branchName || 'N/A' },
    { name: 'Branch_Code', value: branchCode || 'N/A' },
    { name: 'Total_Installment_Price', value: String(totalInstallmentPrice || 0) },
    { name: 'Installment_Duration', value: String(installmentDuration || 0) },
    { name: 'Monthly_Installment', value: String(monthlyInstallment || 0) },
    { name: 'Next_Due_Date', value: nextDueDate || 'N/A' },
    { name: 'Remaining_Amount', value: String(remainingAmount || 0) },
    { name: 'Ledger_Link', value: ledgerUrl || 'N/A' },
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
  // Live template (installment_status_ledger) only has {{1}}..{{8}} — 7 body vars
  // plus the dynamic "View Ledger" button ({{8}}). There is no 9th slot for a
  // complaint link on this template; sending one is an unmatched extra param.
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: productName || 'N/A' },
    { name: '3', value: orderRef || 'N/A' },
    { name: '4', value: nextMonthLabel || 'Mahina 1' },
    { name: '5', value: String(monthlyAmount || 0) },
    { name: '6', value: dueDate || 'N/A' },
    { name: '7', value: String(totalRemaining || 0) },
    { name: '8', value: ledgerUrl || 'N/A' },
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
  // Live template (installment_payment_receipt) has no buttons at all — only
  // {{1}}..{{5}} in the body. A 6th "complaint link" param has no placeholder to fill.
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: String(amount || 0) },
    { name: '3', value: productName || 'N/A' },
    { name: '4', value: orderRef || 'N/A' },
    { name: '5', value: date || new Date().toDateString() },
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
  // Live template (next_installment_reminder) only has {{1}}..{{4}} in the body
  // plus the dynamic "View Ledger" button ({{5}}) — no complaint-link slot.
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: productName || 'N/A' },
    { name: '3', value: String(monthlyAmount || 0) },
    { name: '4', value: dueDate || 'N/A' },
    { name: '5', value: ledgerUrl || 'N/A' },
  ];
  return sendTemplate(phone, WATI_REMINDER_TEMPLATE, WATI_REMINDER_BROADCAST, parameters);
};

// ─── Template 5: Complaint Received ───────────────────────────────────────
// Params (in template body order): Customer_Name, Complaint_ID, Complaint_Date,
// Complaint_By_Name, Complaint_By_Number, Complaint_By_Designation,
// Complaint_Tracking_Link (bare complaint_id — WATI template already has the
// https://api.qistmarket.pk/complaints/track/ prefix baked in as literal text).
const WATI_COMPLAINT_RECEIVED_TEMPLATE = process.env.WATI_COMPLAINT_RECEIVED_TEMPLATE || 'complaint_received';
const WATI_COMPLAINT_RECEIVED_BROADCAST = process.env.WATI_COMPLAINT_RECEIVED_TEMPLATE || 'complaint_received';

const sendComplaintReceived = async (phone, {
  customerName,
  complaintId,
  complaintDate,
  complaintByName,
  complaintByNumber,
  complaintByDesignation,
  trackingLink,
}) => {
  const parameters = [
    { name: 'Customer_Name', value: customerName || 'Customer' },
    { name: 'Complaint_ID', value: complaintId || 'N/A' },
    { name: 'Complaint_Date', value: complaintDate || new Date().toLocaleDateString('en-PK') },
    { name: 'Complaint_By_Name', value: complaintByName || 'SELF' },
    { name: 'Complaint_By_Number', value: complaintByNumber || 'SELF' },
    { name: 'Complaint_By_Designation', value: complaintByDesignation || 'SELF' },
    { name: 'Complaint_Tracking', value: trackingLink || complaintId || 'N/A' },
  ];
  return sendTemplate(phone, WATI_COMPLAINT_RECEIVED_TEMPLATE, WATI_COMPLAINT_RECEIVED_BROADCAST, parameters);
};

// ─── Template 5b: Complaint Assigned ────────────────────────────────────────
// Params (in template body order): Customer_Name, Complaint_ID, Assigned_User_Name,
// Assigned_User_Number, Assigned_User_Designation, Complaint_Date, Complaint_Tracking_Link
// (bare complaint_id — same "COMPLAINT TRACK KAREIN" dynamic button pattern as complaint_received).
const WATI_COMPLAINT_ASSIGNED_TEMPLATE = process.env.WATI_COMPLAINT_ASSIGNED_TEMPLATE || 'complaint_assigned';
const WATI_COMPLAINT_ASSIGNED_BROADCAST = process.env.WATI_COMPLAINT_ASSIGNED_TEMPLATE || 'complaint_assigned';

const sendComplaintAssigned = async (phone, {
  customerName,
  complaintId,
  assignedUserName,
  assignedUserNumber,
  assignedUserDesignation,
  complaintDate,
}) => {
  // Live template (complaint_assigned) only has these 6 named body vars and a
  // STATIC complaint-register button — no Complaint_Tracking placeholder/button
  // exists here (unlike complaint_receive / complaint_resolve), so no tracking param.
  const parameters = [
    { name: 'Customer_Name', value: customerName || 'Customer' },
    { name: 'Complaint_ID', value: complaintId || 'N/A' },
    { name: 'Assigned_User_Name', value: assignedUserName || 'N/A' },
    { name: 'Assigned_User_Number', value: assignedUserNumber || 'N/A' },
    { name: 'Assigned_User_Designation', value: assignedUserDesignation || 'N/A' },
    { name: 'Complaint_Date', value: complaintDate || new Date().toLocaleDateString('en-PK') },
  ];
  return sendTemplate(phone, WATI_COMPLAINT_ASSIGNED_TEMPLATE, WATI_COMPLAINT_ASSIGNED_BROADCAST, parameters);
};

// ─── Template 6: Complaint Resolved ───────────────────────────────────────
// Params (in template body order): Customer_Name, Complaint_ID, Complaint_Subject,
// Resolution_Remarks, Solved_By_Name, Solved_By_Number, Solved_By_Designation,
// Resolved_Date, Resolved_Time, Complaint_Tracking_Link (bare complaint_id — same
// dynamic-button pattern as complaint_received / complaint_assigned).
const WATI_COMPLAINT_RESOLVED_TEMPLATE = process.env.WATI_COMPLAINT_RESOLVED_TEMPLATE || 'complaint_resolved';
const WATI_COMPLAINT_RESOLVED_BROADCAST = process.env.WATI_COMPLAINT_RESOLVED_TEMPLATE || 'complaint_resolved';

const sendComplaintResolved = async (phone, {
  customerName,
  complaintId,
  complaintSubject,
  resolutionRemarks,
  solvedByName,
  solvedByNumber,
  solvedByDesignation,
  resolvedDate,
  resolvedTime,
  trackingLink,
}) => {
  const parameters = [
    { name: 'Customer_Name', value: customerName || 'Customer' },
    { name: 'Complaint_ID', value: complaintId || 'N/A' },
    { name: 'Complaint_Subject', value: complaintSubject || 'N/A' },
    { name: 'Resolution_Remarks', value: resolutionRemarks || 'Resolved gracefully' },
    { name: 'Solved_By_Name', value: solvedByName || 'N/A' },
    { name: 'Solved_By_Number', value: solvedByNumber || 'N/A' },
    { name: 'Solved_By_Designation', value: solvedByDesignation || 'N/A' },
    { name: 'Resolved_Date', value: resolvedDate || new Date().toLocaleDateString('en-PK') },
    { name: 'Resolved_Time', value: resolvedTime || new Date().toLocaleTimeString('en-PK') },
    { name: 'Complaint_Tracking', value: trackingLink || complaintId || 'N/A' },
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
    { name: 'Customer_Name', value: customerName || 'Customer' },
    { name: 'Order_Number', value: orderNumber || 'N/A' },
    { name: 'Item_Name_Model', value: itemName || 'N/A' },
    { name: 'Advance_Amount', value: String(advanceAmount || 0) },
    { name: 'Installment_Duration', value: String(installmentDuration || 'N/A') },
    { name: 'Monthly_Installment', value: String(monthlyInstallment || 0) },
    { name: 'Order_Booker_Name', value: orderBookerName || 'Qist Market' },
    { name: 'Order_Booker_Number', value: orderBookerNumber || 'N/A' },
  ];
  // Note: the "Complaint Register Karein" link is a STATIC website button
  // configured in the WATI template itself, not a body variable — don't add
  // COMPLAINT_URL here, there's no placeholder for it.
  return sendTemplate(phone, WATI_ORDER_BOOKING_TEMPLATE, WATI_ORDER_BOOKING_BROADCAST, parameters);
};

// ─── Template 10: Order Transferred to Outlet ──────────────────────────────
const WATI_ORDER_TRANSFER_TEMPLATE = process.env.WATI_ORDER_TRANSFER_TEMPLATE || 'order_transfer_updates';
const WATI_ORDER_TRANSFER_BROADCAST = process.env.WATI_ORDER_TRANSFER_TEMPLATE || 'order_transfer_updates';

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
    { name: 'Customer_Name', value: customerName || 'Customer' },
    { name: 'Order_Number', value: orderNumber || 'N/A' },
    { name: 'Item_Name_Model', value: itemName || 'N/A' },
    { name: 'Advance_Amount', value: String(advanceAmount || 0) },
    { name: 'Installment_Duration', value: String(installmentDuration || 'N/A') },
    { name: 'Monthly_Installment', value: String(monthlyInstallment || 0) },
    { name: 'Outlet_Name', value: outletName || 'N/A' },
    { name: 'Front_Desk_Officer_Name', value: frontDeskOfficerName || 'N/A' },
    { name: 'Front_Desk_Officer_Number', value: frontDeskOfficerNumber || 'N/A' },
  ];
  // Complaint link is a static website button on the template — no body variable for it.
  return sendTemplate(phone, WATI_ORDER_TRANSFER_TEMPLATE, WATI_ORDER_TRANSFER_BROADCAST, parameters);
};

// ─── Template 11: Verification Officer Assigned ────────────────────────────
const WATI_VERIFICATION_OFFICER_ASSIGNED_TEMPLATE = process.env.WATI_VERIFICATION_OFFICER_ASSIGNED_TEMPLATE || 'verification_officers_assigned';
const WATI_VERIFICATION_OFFICER_ASSIGNED_BROADCAST = process.env.WATI_VERIFICATION_OFFICER_ASSIGNED_TEMPLATE || 'verification_officers_assigned';

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
    { name: 'Customer_Name', value: customerName || 'Customer' },
    { name: 'Order_Number', value: orderNumber || 'N/A' },
    { name: 'Item_Name_Model', value: itemName || 'N/A' },
    { name: 'Advance_Amount', value: String(advanceAmount || 0) },
    { name: 'Installment_Duration', value: String(installmentDuration || 'N/A') },
    { name: 'Monthly_Installment', value: String(monthlyInstallment || 0) },
    { name: 'Outlet_Name', value: outletName || 'N/A' },
    { name: 'Verification_Officer_Name', value: verificationOfficerName || 'N/A' },
    { name: 'Verification_Officer_Number', value: verificationOfficerNumber || 'N/A' },
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
    { name: 'Customer_Name', value: customerName || 'Customer' },
    { name: 'Order_Number', value: orderNumber || 'N/A' },
    { name: 'Item_Name_Model', value: itemName || 'N/A' },
    { name: 'Advance_Amount', value: String(advanceAmount || 0) },
    { name: 'Installment_Duration', value: String(installmentDuration || 'N/A') },
    { name: 'Monthly_Installment', value: String(monthlyInstallment || 0) },
    { name: 'Outlet_Name', value: outletName || 'N/A' },
    { name: 'Verification_Officer_Name', value: verificationOfficerName || 'N/A' },
    { name: 'Verification_Officer_Number', value: verificationOfficerNumber || 'N/A' },
    { name: 'Verification_Start_Date_Time', value: verificationStartDateTime || new Date().toString() },
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
  // This template uses named body variables ({{Customer_Name}}, {{Order_Number}}, ...)
  // rather than positional ({{1}}, {{2}}, ...) — the `name` here must match those
  // placeholder names exactly, or WATI rejects the send with a generic
  // "cannot have typos or blank text" error even though every value is populated.
  const parameters = [
    { name: 'Customer_Name', value: customerName || 'Customer' },
    { name: 'Order_Number', value: orderNumber || 'N/A' },
    { name: 'Item_Name_Model', value: itemName || 'N/A' },
    { name: 'Advance_Amount', value: String(advanceAmount || 0) },
    { name: 'Installment_Duration', value: String(installmentDuration || 'N/A') },
    { name: 'Monthly_Installment', value: String(monthlyInstallment || 0) },
    { name: 'Outlet_Name', value: outletName || 'N/A' },
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
    { name: 'Customer_Name', value: customerName || 'Customer' },
    { name: 'Order_Number', value: orderNumber || 'N/A' },
    { name: 'Item_Name_Model', value: itemName || 'N/A' },
    { name: 'Advance_Amount', value: String(advanceAmount || 0) },
    { name: 'Installment_Duration', value: String(installmentDuration || 'N/A') },
    { name: 'Monthly_Installment', value: String(monthlyInstallment || 0) },
    { name: 'Outlet_Name', value: outletName || 'N/A' },
    { name: 'Cancelled_By_Name', value: cancelledByName || 'Qist Market' },
    { name: 'Cancelled_By_Role', value: cancelledByRole || 'N/A' },
    { name: 'Cancellation_Reason', value: cancellationReason || 'N/A' },
    { name: 'Cancellation_Date_Time', value: cancellationDateTime || new Date().toString() },
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
    { name: 'Customer_Name', value: customerName || 'Customer' },
    { name: 'Order_Number', value: orderNumber || 'N/A' },
    { name: 'Item_Name_Model', value: itemName || 'N/A' },
    { name: 'Advance_Amount', value: String(advanceAmount || 0) },
    { name: 'Installment_Duration', value: String(installmentDuration || 'N/A') },
    { name: 'Monthly_Installment', value: String(monthlyInstallment || 0) },
    { name: 'Outlet_Name', value: outletName || 'N/A' },
    { name: 'Final_Decision_Date_Time', value: decisionDateTime || new Date().toString() },
    { name: 'Analyzer_1_Name', value: analyzer1Name || 'N/A' },
    { name: 'Analyzer_1_Decision', value: analyzer1Decision || 'N/A' },
    { name: 'Analyzer_1_Feedback', value: analyzer1Feedback || 'N/A' },
    { name: 'Analyzer_2_Name', value: analyzer2Name || 'N/A' },
    { name: 'Analyzer_2_Decision', value: analyzer2Decision || 'N/A' },
    { name: 'Analyzer_2_Feedback', value: analyzer2Feedback || 'N/A' },
    { name: 'Third_Analyzer_Review_Section', value: thirdAnalyzerSection || 'N/A' },
    { name: 'Front_Desk_Officer_Name', value: frontDeskOfficerName || 'N/A' },
    { name: 'Front_Desk_Officer_Number', value: frontDeskOfficerNumber || 'N/A' },
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
    { name: 'Customer_Name', value: customerName || 'Customer' },
    { name: 'Order_Number', value: orderNumber || 'N/A' },
    { name: 'Item_Name_Model', value: itemName || 'N/A' },
    { name: 'Advance_Amount', value: String(advanceAmount || 0) },
    { name: 'Installment_Duration', value: String(installmentDuration || 'N/A') },
    { name: 'Monthly_Installment', value: String(monthlyInstallment || 0) },
    { name: 'Outlet_Name', value: outletName || 'N/A' },
    { name: 'Final_Decision_Date_Time', value: decisionDateTime || new Date().toString() },
    { name: 'Analyzer_1_Name', value: analyzer1Name || 'N/A' },
    { name: 'Analyzer_1_Decision', value: analyzer1Decision || 'N/A' },
    { name: 'Analyzer_1_Feedback', value: analyzer1Feedback || 'N/A' },
    { name: 'Analyzer_2_Name', value: analyzer2Name || 'N/A' },
    { name: 'Analyzer_2_Decision', value: analyzer2Decision || 'N/A' },
    { name: 'Analyzer_2_Feedback', value: analyzer2Feedback || 'N/A' },
    { name: 'Third_Analyzer_Review_Section', value: thirdAnalyzerSection || 'N/A' },
    { name: 'Final_Rejection_Reason', value: finalRejectionReason || 'N/A' },
    { name: 'Front_Desk_Officer_Name', value: frontDeskOfficerName || 'N/A' },
    { name: 'Front_Desk_Officer_Number', value: frontDeskOfficerNumber || 'N/A' },
  ];
  // Complaint link is a static website button on the template — no body variable for it.
  return sendTemplate(phone, WATI_FINAL_REJECTION_TEMPLATE, WATI_FINAL_REJECTION_BROADCAST, parameters);
};

// ─── Template 17: Account / Payment Safety Awareness ───────────────────────
// Params (in template body order): Customer_Name, Order_Number, Item_Name_Model,
// Order_Booker_Name, Order_Booker_Number, Verification_Officer_Name,
// Verification_Officer_Number, Branch_Name, Branch_Code, Branch_Contact_Number,
// Complaint_Link. The last two are fixed company-wide values, not per-order data.
const WATI_ACCOUNT_AWARENESS_TEMPLATE = process.env.WATI_ACCOUNT_AWARENESS_TEMPLATE || 'account_awareness';
const WATI_ACCOUNT_AWARENESS_BROADCAST = process.env.WATI_ACCOUNT_AWARENESS_TEMPLATE || 'account_awareness';

const sendAccountAwareness = async (phone, {
  customerName,
  orderNumber,
  itemName,
  orderBookerName,
  orderBookerNumber,
  verificationOfficerName,
  verificationOfficerNumber,
  branchName,
  branchCode,
}) => {
  // Live template (account_awareness) has 10 named body vars and a STATIC
  // complaint-register button — no 11th "complaint link" placeholder to fill.
  const parameters = [
    { name: 'Customer_Name', value: customerName || 'Customer' },
    { name: 'Order_Number', value: orderNumber || 'N/A' },
    { name: 'Item_Name_Model', value: itemName || 'N/A' },
    { name: 'Order_Booker_Name', value: orderBookerName || 'Qist Market' },
    { name: 'Order_Booker_Number', value: orderBookerNumber || 'N/A' },
    { name: 'Verification_Officer_Name', value: verificationOfficerName || 'N/A' },
    { name: 'Verification_Officer_Number', value: verificationOfficerNumber || 'N/A' },
    { name: 'Branch_Name', value: branchName || 'N/A' },
    { name: 'Branch_Code', value: branchCode || 'N/A' },
    { name: 'Branch_Contact_Number', value: QIST_BRANCH_CONTACT_NUMBER },
  ];
  return sendTemplate(phone, WATI_ACCOUNT_AWARENESS_TEMPLATE, WATI_ACCOUNT_AWARENESS_BROADCAST, parameters);
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

// ─── Cash Sale Confirmation (outright walk-in sale, separate from the
// installment flow above) ───────────────────────────────────────────────
// Params (in template body order — must match the live WATI template exactly):
// 1 Customer_Name  2 Item_Name  3 IMEI_Serial  4 Final_Price  5 Sale_Date  6 Outlet_Name
//
// This template must be created and approved on the WATI dashboard before
// sends will actually deliver — until then this call fails soft (same as
// every other sendTemplate call) and the customer still gets the plain-text
// SMS sent alongside it by customerNotificationService.notifyCashSale.
const WATI_CASH_SALE_TEMPLATE = process.env.WATI_CASH_SALE_TEMPLATE || 'cash_sale_confirmation';
const WATI_CASH_SALE_BROADCAST = process.env.WATI_CASH_SALE_TEMPLATE || 'cash_sale_confirmation';

const sendCashSaleInvoice = async (phone, {
  customerName,
  productName,
  imei,
  finalPrice,
  saleDate,
  outletName,
}) => {
  return sendTemplate(phone, WATI_CASH_SALE_TEMPLATE, WATI_CASH_SALE_BROADCAST, [
    { name: '1', value: customerName || '' },
    { name: '2', value: productName || '' },
    { name: '3', value: imei || 'N/A' },
    { name: '4', value: String(finalPrice ?? '0') },
    { name: '5', value: saleDate || '' },
    { name: '6', value: outletName || 'N/A' },
  ]);
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
  sendComplaintAssigned,
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
  sendAccountAwareness,
  sendCashSaleInvoice,
  sendToMany,
  getCompanyNotifyPhones,
};