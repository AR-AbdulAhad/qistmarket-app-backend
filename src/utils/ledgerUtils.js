const prisma = require('../../lib/prisma');

/**
 * Normalizes ledger rows by rolling over overdue unpaid amounts to the next month.
 * @param {Array} rows - The ledger rows array.
 * @returns {Array} - The normalized ledger rows.
 */
function normalizeLedger(rows) {
    if (!Array.isArray(rows)) return [];

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const updatedRows = JSON.parse(JSON.stringify(rows)); // Deep copy

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
        if (status !== 'paid' && row.paidAmount > 0 && row.remainingAmount > 0) {
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
        const isOverdueUnpaid = dDate && !isNaN(dDate.getTime()) && dDate <= todayEnd && status !== 'paid';

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
    const advanceStatus = (advanceRow?.status || '').toLowerCase();
    const advancePayment = {
        amount: Number(advanceRow?.amount || 0),
        paid: advanceStatus === 'paid',
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

    // Calculate totalArrears (the exact sum of remaining balance for ALL overdue/unpaid months up to today)
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    let totalArrears = 0;
    let overdueInstallments = 0;
    for (const r of installmentLedger) {
        const d = r.dueDate ? new Date(r.dueDate) : null;
        const isPaid = (r.status || '').toLowerCase() === 'paid';
        const isOverdueUnpaid = d && !isNaN(d.getTime()) && d <= todayEnd && !isPaid;
        if (isOverdueUnpaid) {
            totalArrears += Number(r.remainingAmount || 0);
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
        totalDue: totalArrears,
        dueAmount: totalArrears,
        grandTotalDue,
        grandTotalPaid,
        grandTotalRemaining,
        paidInstallments: installmentLedger.filter(r => (r.status || '').toLowerCase() === 'paid').length,
        pendingInstallments: installmentLedger.filter(r => (r.status || '').toLowerCase() !== 'paid').length,
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
 * - due: overdue (due date already passed/on today) and still unpaid — genuine
 *   arrears, not the full outstanding balance. Sums ALL overdue unpaid months.
 * - current: the single nearest not-yet-overdue unpaid row (the
 *   installment currently expected to be paid), never future months
 *   beyond that.
 */
function computeDueAndCurrent(installmentLedgerRows) {
    const rows = Array.isArray(installmentLedgerRows) ? installmentLedgerRows : [];
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    let due = 0;
    let nearestUpcoming = null;

    for (const row of rows) {
        const status = (row.status || '').toLowerCase();
        if (status === 'paid') continue;

        const dueDate = row.dueDate ? new Date(row.dueDate) : null;
        if (!dueDate || isNaN(dueDate.getTime())) continue;

        const remAmount = Math.max(0, Number(row.remainingAmount !== undefined ? row.remainingAmount : (row.dueAmount || row.amount || 0) - (row.paidAmount || row.paid_amount || 0)));

        if (dueDate <= todayEnd) {
            due += remAmount;
        } else if (!nearestUpcoming || dueDate < new Date(nearestUpcoming.dueDate)) {
            nearestUpcoming = row;
        }
    }

    const current = nearestUpcoming ? Math.max(0, Number(nearestUpcoming.remainingAmount !== undefined ? nearestUpcoming.remainingAmount : (nearestUpcoming.dueAmount || nearestUpcoming.amount || 0) - (nearestUpcoming.paidAmount || nearestUpcoming.paid_amount || 0))) : 0;
    return { due, current };
}

module.exports = {
    normalizeLedger,
    getNormalizedLedger,
    computeDueAndCurrent
};
