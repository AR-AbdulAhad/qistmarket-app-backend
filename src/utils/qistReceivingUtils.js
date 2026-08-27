/**
 * Sends the "qist_receiving" / "partial_payment" / "last_installment" WATI
 * templates — the rich installment-payment receipts (paid amount,
 * mode/channel or collecting representative, remaining loan balance, ledger
 * link) fired once a ledger row is fully or partially paid. Centralised here
 * since every payment-collection controller (outlet counter, recovery
 * officer, SmartPay, 1LINK TPS) needs the same remaining-balance lookups from
 * the ledger rows.
 */
const prisma = require('../../lib/prisma');
const { sendQistReceiving, sendPartialPayment, sendLastInstallment } = require('../services/watiService');

/**
 * Resolves the "Received By" name/phone shown on Cash payment receipts.
 * `req.user` from the JWT usually only carries id/role_id/outlet_id — its
 * own `full_name`/`phone` are frequently blank or a placeholder like the
 * literal string "testoutlet" (a seeded test account's login name, not a
 * real person), so this always re-fetches the DB user, prefers the linked
 * Employee profile's real name/phone, and finally falls back to any active
 * employee/user at the outlet with a phone on file.
 */
const getRepresentativeOfficerDetails = async (user, outletId) => {
    let name = user?.full_name;
    let phone = user?.phone;

    if (user?.id) {
        try {
            const dbUser = await prisma.user.findUnique({
                where: { id: parseInt(user.id) },
                select: {
                    full_name: true,
                    phone: true,
                    employee_profile: { select: { full_name: true, phone: true } }
                }
            });
            if (dbUser) {
                if (dbUser.full_name && dbUser.full_name.toLowerCase() !== 'testoutlet') {
                    name = dbUser.full_name;
                }
                if (dbUser.phone) phone = dbUser.phone;
                if (dbUser.employee_profile) {
                    if (dbUser.employee_profile.full_name) name = dbUser.employee_profile.full_name;
                    if (dbUser.employee_profile.phone) phone = dbUser.employee_profile.phone;
                }
            }
        } catch (err) {
            console.error('Error fetching dbUser in getRepresentativeOfficerDetails:', err);
        }
    }

    if ((!phone || phone === 'N/A') && outletId) {
        try {
            const employee = await prisma.employee.findFirst({
                where: {
                    outlet_id: parseInt(outletId),
                    status: 'active',
                    phone: { not: null }
                },
                select: { full_name: true, phone: true }
            });
            if (employee && employee.phone) {
                if (!name || name.toLowerCase() === 'testoutlet') name = employee.full_name;
                phone = employee.phone;
            } else {
                const branchUser = await prisma.user.findFirst({
                    where: {
                        outlet_id: parseInt(outletId),
                        status: 'active',
                        phone: { not: null }
                    },
                    select: { full_name: true, phone: true }
                });
                if (branchUser && branchUser.phone) {
                    if (!name || name.toLowerCase() === 'testoutlet') name = branchUser.full_name;
                    phone = branchUser.phone;
                }
            }
        } catch (err) {
            console.error('Error fetching outlet officer in getRepresentativeOfficerDetails:', err);
        }
    }

    return {
        name: name || 'Outlet Representative',
        phone: phone || 'N/A'
    };
};

// The template always renders both the "Online" and "Cash" lines (WhatsApp
// templates have no conditionals), so whichever side doesn't apply is filled
// with 'N/A' by leaving it out here and letting sendQistReceiving default it.
const derivePaymentMode = (paymentMethod) => (/cash/i.test(paymentMethod || '') ? 'Cash' : 'Online');

// "Through" line on the online receipt: the channel/gateway name plus the
// transaction ID that went through it, so the customer can see exactly
// which online payment this receipt matches (e.g. "SmartPay QR - TXN123").
const deriveOnlineChannel = (channel, method, transactionId) => {
  const label = channel || method || 'Online';
  return transactionId ? `${label} - ${transactionId}` : label;
};

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
      paymentChannel: mode === 'Online' ? deriveOnlineChannel(paymentChannel, paymentMethod, transactionId) : null,
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
      paymentChannel: mode === 'Online' ? deriveOnlineChannel(paymentChannel, paymentMethod, transactionId) : null,
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

module.exports = { sendQistReceivingForPayment, sendPartialPaymentForRow, getRepresentativeOfficerDetails };
