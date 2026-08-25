/**
 * Sends the "qist_receiving" / "partial_payment" / "last_installment" WATI
 * templates — the rich installment-payment receipts (paid amount,
 * mode/channel or collecting representative, remaining loan balance, ledger
 * link) fired once a ledger row is fully or partially paid. Centralised here
 * since every payment-collection controller (outlet counter, recovery
 * officer, SmartPay, 1LINK TPS) needs the same remaining-balance lookups from
 * the ledger rows.
 */
const { sendQistReceiving, sendPartialPayment, sendLastInstallment } = require('../services/watiService');

// The template always renders both the "Online" and "Cash" lines (WhatsApp
// templates have no conditionals), so whichever side doesn't apply is filled
// with 'N/A' by leaving it out here and letting sendQistReceiving default it.
const derivePaymentMode = (paymentMethod) => (/cash/i.test(paymentMethod || '') ? 'Cash' : 'Online');

async function sendQistReceivingForPayment(phone, {
  order,
  ledger,
  rows,
  rowIndex,
  customerName,
  productName,
  paidAmount,
  paymentMethod,
  paymentDate,
  transactionId,
  representativeName,
  representativeNumber,
  paymentChannel,
} = {}) {
  if (!phone || !order || !ledger || !Array.isArray(rows) || rowIndex == null || rowIndex < 0) return;

  try {
    // Every other row that isn't fully paid yet — used for the
    // remaining-balance total AND to detect the last installment. Checking
    // the whole ledger (not just rows after rowIndex) catches an
    // out-of-sequence payoff too, e.g. month 3 paid before month 2.
    const unpaidOtherRows = rows.filter((r, idx) => idx !== rowIndex && r.status !== 'paid');
    const remainingBalance = unpaidOtherRows.reduce((sum, r) => {
      const due = parseFloat(r.amount || r.dueAmount || 0);
      const paid = parseFloat(r.paid_amount || 0);
      return sum + Math.max(0, due - paid);
    }, 0);

    const ledgerUrl = ledger.short_id || ledger.token || null;
    const mode = derivePaymentMode(paymentMethod);

    // No unpaid rows left anywhere on the ledger — this was the last
    // installment, so the loan-cleared template replaces qist_receiving
    // entirely rather than just omitting the "next installment" fields.
    if (unpaidOtherRows.length === 0) {
      const result = await sendLastInstallment(phone, {
        customerName,
        itemName: productName,
        orderRef: order.order_ref,
        paidAmount,
        transactionId,
        ledgerUrl,
      });
      console.log('[WATI] Last installment:', result?.success ? 'sent ✓' : result?.error);
      return result;
    }

    // Ledger rows are created in month order, so the first remaining unpaid
    // row (by array position) is also the nearest one due chronologically.
    const nextRow = unpaidOtherRows[0];

    const result = await sendQistReceiving(phone, {
      customerName,
      productName,
      paidAmount,
      paymentMode: mode,
      paymentDate,
      transactionId,
      orderRef: order.order_ref,
      remainingBalance,
      paymentChannel: mode === 'Online' ? (paymentChannel || paymentMethod) : null,
      representativeName: mode === 'Cash' ? representativeName : null,
      representativeNumber: mode === 'Cash' ? representativeNumber : null,
      nextInstallmentAmount: nextRow.amount || nextRow.dueAmount,
      nextInstallmentDate: new Date(nextRow.due_date || nextRow.dueDate).toLocaleDateString('en-PK'),
      ledgerUrl,
    });
    console.log('[WATI] Qist receiving:', result?.success ? 'sent ✓' : result?.error);
    return result;
  } catch (e) {
    console.error('[qistReceivingUtils] sendQistReceivingForPayment error:', e);
  }
}

async function sendPartialPaymentForRow(phone, {
  order,
  ledger,
  rows,
  rowIndex,
  customerName,
  productName,
  paidAmount,
  paymentMethod,
  paymentDate,
  transactionId,
  representativeName,
  representativeNumber,
  paymentChannel,
} = {}) {
  if (!phone || !order || !ledger || !Array.isArray(rows) || rowIndex == null || rowIndex < 0) return;

  try {
    const row = rows[rowIndex] || {};
    const installmentAmount = parseFloat(row.amount || row.dueAmount || 0);
    const installmentRemaining = Math.max(0, installmentAmount - parseFloat(row.paid_amount || 0));

    // Total remaining across the whole loan — every row not yet fully paid,
    // this one included since it's still only partially settled.
    const remainingBalance = rows.reduce((sum, r) => {
      if (r.status === 'paid') return sum;
      const due = parseFloat(r.amount || r.dueAmount || 0);
      const paid = parseFloat(r.paid_amount || 0);
      return sum + Math.max(0, due - paid);
    }, 0);

    const ledgerUrl = ledger.short_id || ledger.token || null;
    const mode = derivePaymentMode(paymentMethod);
    const dueDateRaw = row.due_date || row.dueDate;

    const result = await sendPartialPayment(phone, {
      customerName,
      productName,
      paidAmount,
      paymentMode: mode,
      paymentDate,
      transactionId,
      orderRef: order.order_ref,
      installmentAmount,
      installmentRemaining,
      remainingBalance,
      paymentChannel: mode === 'Online' ? (paymentChannel || paymentMethod) : null,
      representativeName: mode === 'Cash' ? representativeName : null,
      representativeNumber: mode === 'Cash' ? representativeNumber : null,
      dueDate: dueDateRaw ? new Date(dueDateRaw).toLocaleDateString('en-PK') : null,
      ledgerUrl,
    });
    console.log('[WATI] Partial payment:', result?.success ? 'sent ✓' : result?.error);
    return result;
  } catch (e) {
    console.error('[qistReceivingUtils] sendPartialPaymentForRow error:', e);
  }
}

module.exports = { sendQistReceivingForPayment, sendPartialPaymentForRow };
