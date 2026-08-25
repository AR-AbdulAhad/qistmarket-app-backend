/**
 * Daily digest that sends the "installment_reminder" WATI template to every
 * customer whose next unpaid installment falls due in exactly
 * REMINDER_DAYS_BEFORE days — a proactive nudge, not something triggered by
 * a payment event (compare sendNextInstallmentReminder in watiService.js,
 * which fires right after a payment instead of on a schedule).
 *
 * Ledger rows are a JSON blob (InstallmentLedger.ledger_rows), so there's no
 * DB column to mark "already reminded" — a `reminder_sent_at` timestamp is
 * stamped directly onto the row and persisted back, the same way other
 * per-row fields (paid_at, collected_by, transaction_id, ...) already get
 * bolted onto rows elsewhere in the codebase. That stamp is what keeps a
 * cron re-run (or a manual trigger) from sending the same customer the same
 * reminder twice.
 */
const prisma = require('../../lib/prisma');
const { sendInstallmentReminder } = require('./watiService');

const REMINDER_DAYS_BEFORE = 3;
const CLOSED_ORDER_STATUSES = ['Cancelled', 'Rejected', 'Returned'];

const isSameCalendarDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const runInstallmentReminders = async () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const targetDate = new Date(today);
  targetDate.setDate(targetDate.getDate() + REMINDER_DAYS_BEFORE);

  let sentCount = 0;
  let failedCount = 0;

  try {
    const ledgers = await prisma.installmentLedger.findMany({
      where: { order: { status: { notIn: CLOSED_ORDER_STATUSES } } },
      include: {
        order: { include: { verification: { include: { purchaser: true } } } },
      },
    });

    for (const ledger of ledgers) {
      const order = ledger.order;
      if (!order) continue;

      const rows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : [];
      let rowsChanged = false;

      for (const row of rows) {
        if (!row.month) continue; // month 0 = advance payment, not a recurring installment
        if ((row.status || '').toLowerCase() === 'paid') continue;
        if (row.reminder_sent_at) continue;

        const dueDateRaw = row.due_date || row.dueDate;
        const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;
        if (!dueDate || isNaN(dueDate.getTime())) continue;
        dueDate.setHours(0, 0, 0, 0);

        if (!isSameCalendarDay(dueDate, targetDate)) continue;

        const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
        if (!phone) continue;

        const result = await sendInstallmentReminder(phone, {
          customerName: order.verification?.purchaser?.name || order.customer_name,
          itemName: order.product_name,
          installmentAmount: row.amount || row.dueAmount,
          installmentDueDate: dueDate.toLocaleDateString('en-PK'),
          orderRef: order.order_ref,
          ledgerUrl: ledger.short_id,
        }).catch((err) => {
          console.error(`[InstallmentReminder] Send failed for order ${order.order_ref}:`, err);
          return { success: false };
        });

        // Stamp regardless of delivery success — a bad phone number or a
        // down WATI account shouldn't retry-storm the same row every day.
        row.reminder_sent_at = new Date().toISOString();
        rowsChanged = true;
        if (result?.success) sentCount += 1;
        else failedCount += 1;
      }

      if (rowsChanged) {
        await prisma.installmentLedger.update({
          where: { id: ledger.id },
          data: { ledger_rows: rows },
        });
      }
    }

    console.log(`[InstallmentReminder] Sent ${sentCount} reminder(s), ${failedCount} failed.`);
  } catch (err) {
    console.error('[InstallmentReminder] Run failed:', err);
  }

  return { sentCount, failedCount };
};

module.exports = { runInstallmentReminders };
