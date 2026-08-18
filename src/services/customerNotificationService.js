const prisma = require('../../lib/prisma');
const watiService = require('./watiService');

// Master switch for all 8 customer-facing order/verification lifecycle
// WhatsApp notifications added here. Separate from WATI_OTP_ENABLED, which
// only gates OTP sends. Default on; set to 'false' in .env to disable all of
// them at once without touching call sites.
const isEnabled = () => process.env.WATI_ORDER_NOTIFICATIONS_ENABLED !== 'false';

const fmt = (n) => (n === null || n === undefined ? '0' : String(Math.round(Number(n))));

const formatDateTime = (date = new Date()) => {
  try {
    return new Date(date).toLocaleString('en-GB', {
      timeZone: 'Asia/Karachi',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch (_) {
    return new Date(date).toDateString();
  }
};

const getOutletName = async (outletId) => {
  if (!outletId) return null;
  try {
    const outlet = await prisma.outlet.findUnique({ where: { id: outletId }, select: { name: true } });
    return outlet?.name || null;
  } catch (err) {
    console.error('[CustomerNotify] getOutletName failed:', err.message);
    return null;
  }
};

// No dedicated "Front Desk Officer" role exists yet — resolved from the
// outlet's active Employee records by job title/designation.
const getFrontDeskOfficer = async (outletId) => {
  if (!outletId) return null;
  try {
    const employee = await prisma.employee.findFirst({
      where: {
        outlet_id: outletId,
        status: 'active',
        designation: { contains: 'front desk' },
      },
      select: { full_name: true, phone: true },
    });
    return employee || null;
  } catch (err) {
    console.error('[CustomerNotify] getFrontDeskOfficer failed:', err.message);
    return null;
  }
};

const baseOrderFields = (order) => ({
  customerName: order.customer_name,
  orderNumber: order.order_ref,
  itemName: order.product_name,
  advanceAmount: fmt(order.advance_amount),
  installmentDuration: order.months,
  monthlyInstallment: fmt(order.monthly_amount),
});

// 1. Order Booking Confirmation
const notifyOrderBooked = async (order) => {
  if (!isEnabled() || !order?.whatsapp_number) return;
  try {
    let bookerName = 'Qist Market';
    let bookerPhone = 'N/A';
    if (order.created_by_user_id) {
      const booker = await prisma.user.findUnique({
        where: { id: order.created_by_user_id },
        select: { full_name: true, phone: true },
      });
      if (booker) {
        bookerName = booker.full_name;
        bookerPhone = booker.phone || 'N/A';
      }
    }
    await watiService.sendOrderBookingConfirmation(order.whatsapp_number, {
      ...baseOrderFields(order),
      orderBookerName: bookerName,
      orderBookerNumber: bookerPhone,
    });
  } catch (err) {
    console.error('[CustomerNotify] notifyOrderBooked failed:', err.message);
  }
};

// 2. Order Transferred to Outlet
const notifyOrderTransferred = async (order) => {
  if (!isEnabled() || !order?.whatsapp_number || !order.outlet_id) return;
  try {
    const [outletName, frontDesk] = await Promise.all([
      getOutletName(order.outlet_id),
      getFrontDeskOfficer(order.outlet_id),
    ]);
    await watiService.sendOrderTransferUpdate(order.whatsapp_number, {
      ...baseOrderFields(order),
      outletName: outletName || 'N/A',
      frontDeskOfficerName: frontDesk?.full_name || 'N/A',
      frontDeskOfficerNumber: frontDesk?.phone || 'N/A',
    });
  } catch (err) {
    console.error('[CustomerNotify] notifyOrderTransferred failed:', err.message);
  }
};

// 3. Verification Officer Assigned
const notifyVerificationOfficerAssigned = async (order, officer) => {
  if (!isEnabled() || !order?.whatsapp_number || !officer) return;
  try {
    const outletName = await getOutletName(order.outlet_id);
    await watiService.sendVerificationOfficerAssigned(order.whatsapp_number, {
      ...baseOrderFields(order),
      outletName: outletName || 'N/A',
      verificationOfficerName: officer.full_name,
      verificationOfficerNumber: officer.phone || 'N/A',
    });
  } catch (err) {
    console.error('[CustomerNotify] notifyVerificationOfficerAssigned failed:', err.message);
  }
};

// 4. Verification Started
const notifyVerificationStarted = async (order, officer, startTime) => {
  if (!isEnabled() || !order?.whatsapp_number) return;
  try {
    const outletName = await getOutletName(order.outlet_id);
    await watiService.sendVerificationStarted(order.whatsapp_number, {
      ...baseOrderFields(order),
      outletName: outletName || 'N/A',
      verificationOfficerName: officer?.full_name || 'N/A',
      verificationOfficerNumber: officer?.phone || 'N/A',
      verificationStartDateTime: formatDateTime(startTime),
    });
  } catch (err) {
    console.error('[CustomerNotify] notifyVerificationStarted failed:', err.message);
  }
};

// 5. Verification Completed
const notifyVerificationCompleted = async (order) => {
  if (!isEnabled() || !order?.whatsapp_number) return;
  try {
    const outletName = await getOutletName(order.outlet_id);
    await watiService.sendVerificationCompleted(order.whatsapp_number, {
      ...baseOrderFields(order),
      outletName: outletName || 'N/A',
    });
  } catch (err) {
    console.error('[CustomerNotify] notifyVerificationCompleted failed:', err.message);
  }
};

// 6. Order Cancellation
const notifyOrderCancelled = async (order, { cancelledByName, cancelledByRole, reason } = {}) => {
  if (!isEnabled() || !order?.whatsapp_number) return;
  try {
    const outletName = await getOutletName(order.outlet_id);
    await watiService.sendOrderCancellation(order.whatsapp_number, {
      ...baseOrderFields(order),
      outletName: outletName || 'N/A',
      cancelledByName: cancelledByName || 'Qist Market',
      cancelledByRole: cancelledByRole || 'N/A',
      cancellationReason: reason || 'N/A',
      cancellationDateTime: formatDateTime(),
    });
  } catch (err) {
    console.error('[CustomerNotify] notifyOrderCancelled failed:', err.message);
  }
};

// 7 & 8. Final Decision — Approval / Rejection (same trigger point, branches on decision)
const notifyFinalDecision = async (order, { decision, reviews } = {}) => {
  if (!isEnabled() || !order?.whatsapp_number) return;
  if (decision !== 'approved' && decision !== 'rejected') return;
  try {
    const [outletName, frontDesk] = await Promise.all([
      getOutletName(order.outlet_id),
      getFrontDeskOfficer(order.outlet_id),
    ]);

    const reviewerIds = [...new Set((reviews || []).map((r) => r.reviewer_id))];
    const reviewers = reviewerIds.length
      ? await prisma.user.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, full_name: true } })
      : [];
    const nameFor = (id) => reviewers.find((r) => r.id === id)?.full_name || 'N/A';

    const [r1, r2, r3] = reviews || [];
    const decisionLabel = (r) => (r ? (r.approved ? 'Approved' : 'Rejected') : 'N/A');

    const payload = {
      ...baseOrderFields(order),
      outletName: outletName || 'N/A',
      decisionDateTime: formatDateTime(),
      analyzer1Name: r1 ? nameFor(r1.reviewer_id) : 'N/A',
      analyzer1Decision: decisionLabel(r1),
      analyzer1Feedback: r1?.remarks || 'N/A',
      analyzer2Name: r2 ? nameFor(r2.reviewer_id) : 'N/A',
      analyzer2Decision: decisionLabel(r2),
      analyzer2Feedback: r2?.remarks || 'N/A',
      thirdAnalyzerSection: r3
        ? `Form Analyzer 3: ${nameFor(r3.reviewer_id)} | Decision: ${decisionLabel(r3)} | Feedback: ${r3.remarks || 'N/A'}`
        : '',
      frontDeskOfficerName: frontDesk?.full_name || 'N/A',
      frontDeskOfficerNumber: frontDesk?.phone || 'N/A',
    };

    if (decision === 'approved') {
      await watiService.sendFinalOrderApproval(order.whatsapp_number, payload);
    } else {
      await watiService.sendFinalOrderRejection(order.whatsapp_number, {
        ...payload,
        finalRejectionReason: (reviews || []).find((r) => !r.approved)?.remarks || 'N/A',
      });
    }
  } catch (err) {
    console.error('[CustomerNotify] notifyFinalDecision failed:', err.message);
  }
};

module.exports = {
  notifyOrderBooked,
  notifyOrderTransferred,
  notifyVerificationOfficerAssigned,
  notifyVerificationStarted,
  notifyVerificationCompleted,
  notifyOrderCancelled,
  notifyFinalDecision,
};
