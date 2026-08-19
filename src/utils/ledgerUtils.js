const prisma = require('../../lib/prisma');

/**
 * Normalizes ledger rows by rolling over overdue unpaid amounts to the next month.
 * @param {Array} rows - The ledger rows array.
 * @returns {Array} - The normalized ledger rows.
 */
function normalizeLedger(rows) {
    if (!Array.isArray(rows)) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const updatedRows = JSON.parse(JSON.stringify(rows)); // Deep copy

    // Running total of shortfall carried forward from prior overdue/unpaid
    // months. This MUST be recomputed fresh from canonical due/paid amounts
    // on every call and never seeded from a previously-persisted `arrears`
    // value — several call sites persist this function's output back to the
    // DB (e.g. after recording a payment) and then call it again later. If
    // arrears were computed as "stored value + newly rolled-over amount"
    // (the old behaviour), every subsequent payment anywhere on the ledger
    // would re-add the rollover on top of the already-stored total, and the
    // number would balloon further with each call instead of staying stable.
    let carriedForward = 0;

    for (let i = 0; i < updatedRows.length; i++) {
        const row = updatedRows[i];

        const status = (row.status || '').toLowerCase();
        const currentDue = Number(row.amount || row.dueAmount || 0);

        // Ensure paid_amount and remainingAmount are present for UI/API consistency
        if (row.paid_amount === undefined) {
            row.paid_amount = (status === 'paid') ? currentDue : 0;
        }
        row.paidAmount = Number(row.paid_amount);
        row.dueAmount = currentDue;
        row.remainingAmount = Math.max(0, currentDue - row.paidAmount);

        // Update status to 'partial' if partially paid
        if (row.status !== 'paid' && row.paidAmount > 0 && row.remainingAmount > 0) {
            row.status = 'partial';
        }

        // Month 0 (Advance) never carries or receives arrears.
        if (row.month === 0) {
            row.arrears = 0;
            continue;
        }

        // Arrears shown ON this row = everything carried forward from prior
        // overdue months only (this row's own due/remaining is shown separately).
        row.arrears = carriedForward;

        const dueDate = row.due_date || row.dueDate;
        const dDate = dueDate ? new Date(dueDate) : null;
        const isOverdueUnpaid = dDate && !isNaN(dDate.getTime()) && dDate < today && row.status !== 'paid';

        if (isOverdueUnpaid) {
            carriedForward += row.remainingAmount;
        }
    }

    return updatedRows;
}

/**
 * Returns a structured object with advance, installments, and a financial summary.
 */
function getNormalizedLedger(rows) {
    const updatedRows = normalizeLedger(rows);
    
    const advanceRow = updatedRows.find(r => r.month === 0);
    const advancePayment = {
        amount: Number(advanceRow?.amount || 0),
        paid: advanceRow?.status === 'paid',
        paidAt: advanceRow?.paid_at || advanceRow?.paidAt || null,
        paymentMethod: advanceRow?.payment_method || advanceRow?.paymentMethod || null,
        status: advanceRow?.status || 'pending',
    };

    const installmentLedger = updatedRows.filter(r => r.month > 0).map(row => ({
        monthNumber: row.month,
        label: row.label || `Month ${row.month}`,
        dueDate: row.due_date || row.dueDate || null,
        dueAmount: Number(row.amount || 0),
        paidAmount: Number(row.paid_amount || 0),
        remainingAmount: Math.max(0, Number(row.amount || 0) - Number(row.paid_amount || 0)),
        status: row.status || 'pending',
        paidAt: row.paid_at || null,
        paymentMethod: row.payment_method || null,
        arrears: row.arrears || 0,
        // Preserve full partial-payment history for both naming conventions
        paymentHistory: row.payment_history || row.paymentHistory || [],
        payment_history: row.payment_history || row.paymentHistory || [],
    }));

    const totalInstallmentDue = installmentLedger.reduce((sum, r) => sum + r.dueAmount, 0);
    const totalInstallmentPaid = installmentLedger.reduce((sum, r) => sum + r.paidAmount, 0);
    const totalInstallmentRemaining = Math.max(0, totalInstallmentDue - totalInstallmentPaid);
    // Each row's `arrears` is a running "carried forward from prior months"
    // total (see normalizeLedger), so summing every row's arrears would count
    // the same underlying shortfall multiple times. The correct ledger-wide
    // total is simply the combined remaining balance of every overdue/unpaid
    // row, counted once each.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let totalArrears = 0;
    let overdueInstallments = 0;
    for (const r of installmentLedger) {
        const d = r.dueDate ? new Date(r.dueDate) : null;
        const isOverdueUnpaid = d && !isNaN(d.getTime()) && d < today && r.status !== 'paid';
        if (isOverdueUnpaid) {
            totalArrears += r.remainingAmount;
            overdueInstallments += 1;
        }
    }

    const grandTotalDue = advancePayment.amount + totalInstallmentDue;
    const grandTotalPaid = (advancePayment.paid ? advancePayment.amount : 0) + totalInstallmentPaid;
    const grandTotalRemaining = Math.max(0, grandTotalDue - grandTotalPaid);

    const summary = {
        totalInstallmentDue,
        totalInstallmentPaid,
        totalInstallmentRemaining,
        totalArrears,
        grandTotalDue,
        grandTotalPaid,
        grandTotalRemaining,
        paidInstallments: installmentLedger.filter(r => r.status === 'paid').length,
        // pendingInstallments = every unpaid row regardless of due date (used
        // elsewhere for the full payment-plan status). overdueInstallments is
        // the "actually needs collecting now" count — only rows whose due date
        // has already passed — needed for recovery/collections dashboards so
        // future not-yet-due installments aren't counted as overdue.
        pendingInstallments: installmentLedger.filter(r => r.status !== 'paid').length,
        overdueInstallments,
        installmentsStarted: updatedRows.some(r => r.month > 0),
        firstInstallmentDate: installmentLedger[0]?.dueDate || null,
    };

    return {
        advance_payment: advancePayment,
        installment_ledger: installmentLedger,
        summary,
        rows: updatedRows // Keep raw rows too
    };
}

/**
 * Splits an already-normalized installment_ledger array (from
 * getNormalizedLedger) into:
 * - due: overdue (due date already passed) and still unpaid — genuine
 *   arrears, not the full outstanding balance.
 * - current: the single nearest not-yet-overdue unpaid row (the
 *   installment currently expected to be paid), never future months
 *   beyond that.
 */
function computeDueAndCurrent(installmentLedgerRows) {
    const rows = Array.isArray(installmentLedgerRows) ? installmentLedgerRows : [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let due = 0;
    let nearestUpcoming = null;

    for (const row of rows) {
        if ((row.status || '').toLowerCase() === 'paid') continue;
        const dueDate = row.dueDate ? new Date(row.dueDate) : null;
        if (!dueDate || isNaN(dueDate.getTime())) continue;

        if (dueDate < today) {
            due += Number(row.remainingAmount || 0);
        } else if (!nearestUpcoming || dueDate < new Date(nearestUpcoming.dueDate)) {
            nearestUpcoming = row;
        }
    }

    const current = nearestUpcoming ? Number(nearestUpcoming.remainingAmount || 0) : 0;
    return { due, current };
}

module.exports = {
    normalizeLedger,
    getNormalizedLedger,
    computeDueAndCurrent
};
