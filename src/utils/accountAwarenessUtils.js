/**
 * Sends the "account_awareness" WATI template — the payment-safety reminder that
 * lists the order booker, verification officer, and branch, and warns the customer
 * to only ever pay through official Qist Market channels. Fired repeatedly across
 * the order lifecycle (delivery, every installment/partial payment) rather than once,
 * so this is a single shared lookup+send instead of duplicating the query at every
 * call site.
 */
const prisma = require('../../lib/prisma');
const { sendAccountAwareness } = require('../services/watiService');

async function sendAccountAwarenessForOrder(orderId, phone, { itemName } = {}) {
  if (!orderId || !phone) return;

  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        created_by: { select: { full_name: true, phone: true } },
        outlet: { select: { name: true, code: true } },
        verification: {
          include: {
            verification_officer: { select: { full_name: true, phone: true } },
          },
        },
      },
    });
    if (!order) return;

    const result = await sendAccountAwareness(phone, {
      customerName: order.customer_name,
      orderNumber: order.order_ref,
      itemName: itemName || order.product_name,
      orderBookerName: order.created_by?.full_name,
      orderBookerNumber: order.created_by?.phone,
      verificationOfficerName: order.verification?.verification_officer?.full_name,
      verificationOfficerNumber: order.verification?.verification_officer?.phone,
      branchName: order.outlet?.name,
      branchCode: order.outlet?.code,
    });
    console.log('[WATI] Account awareness:', result?.success ? 'sent ✓' : result?.error);
  } catch (e) {
    console.error('[accountAwarenessUtils] sendAccountAwarenessForOrder error:', e);
  }
}

module.exports = { sendAccountAwarenessForOrder };
