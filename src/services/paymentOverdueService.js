/**
 * Daily job that sends the "payment_overdue" WATI template to the customer,
 * and "notice_guarantor_overdue" to every grantor on the account, ONCE per
 * account, the first time it crosses into overdue — i.e. it has at least one
 * unpaid installment whose due date has already passed. Mirrors
 * installmentReminderService.js's "N days before due" reminder, just on the
 * other side of the due date, and uses the same per-row stamping trick to
 * avoid re-sending: since ledger rows are a JSON blob with no DB column for
 * "already notified", an `overdue_notice_sent_at` timestamp gets stamped
 * onto every currently-overdue row the first time this fires for that
 * account — checking for that stamp on ANY row (not just the triggering one)
 * is what keeps the account from being renotified once it's already a known
 * defaulter, even as more of its rows individually roll into overdue later.
 *
 * Only fires for accounts with a recovery officer already assigned — the
 * customer template names one ("Recovery Officer: ... Contact: ..."), so an
 * overdue account with nobody assigned yet has nothing meaningful to put there.
 */
const prisma = require('../../lib/prisma');
const { getNormalizedLedger } = require('../utils/ledgerUtils');
const { sendPaymentOverdue, sendGuarantorOverdueNotice } = require('./watiService');

const CLOSED_ORDER_STATUSES = ['Cancelled', 'Rejected', 'Returned'];

const runPaymentOverdueNotices = async () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let sentCount = 0;
  let failedCount = 0;

  try {
    const ledgers = await prisma.installmentLedger.findMany({
      where: {
        order: {
          status: { notIn: CLOSED_ORDER_STATUSES },
          recovery_officer_id: { not: null },
        },
      },
      include: {
        order: {
          include: {
            verification: { include: { purchaser: true, grantors: true } },
            recovery_officer: { select: { full_name: true, phone: true } },
          },
        },
      },
    });

    for (const ledger of ledgers) {
      const order = ledger.order;
      if (!order || !order.recovery_officer) continue;

      const rows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : [];
      if (rows.some((r) => r.overdue_notice_sent_at)) continue; // already notified once

      const overdueRows = rows.filter((r) => {
        if (!r.month) return false; // month 0 = advance payment, not a recurring installment
        if ((r.status || '').toLowerCase() === 'paid') return false;
        const dueDateRaw = r.due_date || r.dueDate;
        const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;
        return dueDate && !isNaN(dueDate.getTime()) && dueDate < today;
      });
      if (overdueRows.length === 0) continue; // not overdue yet

      const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
      const customerName = order.verification?.purchaser?.name || order.customer_name;
      const dueAmount = getNormalizedLedger(rows).summary.totalArrears;
      const ledgerUrl = ledger.short_id || null;

      let result = { success: false };
      if (phone) {
        result = await sendPaymentOverdue(phone, {
          customerName,
          itemName: order.product_name,
          dueAmount,
          orderRef: order.order_ref,
          recoveryOfficerName: order.recovery_officer.full_name,
          recoveryOfficerNumber: order.recovery_officer.phone,
        }).catch((err) => {
          console.error(`[PaymentOverdue] Send failed for order ${order.order_ref}:`, err);
          return { success: false };
        });
      }

      const grantors = Array.isArray(order.verification?.grantors) ? order.verification.grantors : [];
      for (const grantor of grantors) {
        if (!grantor.telephone_number) continue;
        await sendGuarantorOverdueNotice(grantor.telephone_number, {
          guarantorName: grantor.name,
          customerName,
          itemName: order.product_name,
          dueAmount,
          orderRef: order.order_ref,
          ledgerUrl,
        }).catch((err) => console.error(`[PaymentOverdue] Guarantor send failed for order ${order.order_ref}:`, err));
      }

      // Stamp every currently-overdue row regardless of delivery success —
      // a missing phone or a down WATI account shouldn't retry-storm this
      // account every day, and it keeps later-overdue rows from re-triggering.
      const nowIso = new Date().toISOString();
      overdueRows.forEach((r) => { r.overdue_notice_sent_at = nowIso; });
      await prisma.installmentLedger.update({
        where: { id: ledger.id },
        data: { ledger_rows: rows },
      });

      if (result?.success) sentCount += 1;
      else failedCount += 1;
    }

    console.log(`[PaymentOverdue] Sent ${sentCount} notice(s), ${failedCount} failed.`);
  } catch (err) {
    console.error('[PaymentOverdue] Run failed:', err);
  }

  return { sentCount, failedCount };
};

module.exports = { runPaymentOverdueNotices };
