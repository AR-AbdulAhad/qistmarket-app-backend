const prisma = require('../../lib/prisma');
const crypto = require('crypto');

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
function getNormalizedLedger(rows, fallbackAdvance = 0) {
    const updatedRows = normalizeLedger(rows);
    
    const advanceRow = updatedRows.find(r => r.month === 0);
    const advanceStatus = (advanceRow?.status || '').toLowerCase();
    const advancePayment = {
        amount: advanceRow ? Number(advanceRow.amount || 0) : Number(fallbackAdvance || 0),
        paid: advanceRow ? advanceStatus === 'paid' : (fallbackAdvance > 0),
        paidAt: advanceRow?.paid_at || advanceRow?.paidAt || null,
        paymentMethod: advanceRow?.payment_method || advanceRow?.paymentMethod || null,
        status: advanceRow?.status || (advanceRow ? 'pending' : 'paid'),
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

/**
 * Classifies an account exactly the way recoveryController's internal
 * Overdue/Defaulter/Blacklist/Cleared dashboard tiers do (see
 * recoveryController.js ~L2144-2262), but as a standalone, reusable
 * function so the customer-facing ledger page can show the *real* account
 * status instead of the mostly-dead order.status field. Deliberately kept
 * separate from recoveryController's inline version rather than refactoring
 * it to call this — that dashboard is high-traffic/high-stakes internally
 * and isn't part of this change.
 *
 * Rules (unchanged from recoveryController):
 * - Cleared: fully paid off (installments started, nothing remaining).
 * - Defaulter: zero payment against every installment due in the last 3
 *   months (only evaluated once there are 3+ such rows).
 * - Blacklist: some payment in that same 3-month window, but under 50% of
 *   what was due.
 * - Overdue: 2+ unpaid installments whose due date has already passed.
 * - Regular: exactly 1 unpaid overdue installment.
 * - Active: nothing overdue at all.
 */
function classifyLedgerAccountStatus(installmentLedgerRows) {
    const rows = Array.isArray(installmentLedgerRows) ? installmentLedgerRows : [];
    const today = new Date();
    const threeMonthsAgo = new Date(today);
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const installmentsStarted = rows.length > 0;
    const grandTotalRemaining = rows.reduce((s, r) => s + Number(r.remainingAmount || 0), 0);

    if (installmentsStarted && grandTotalRemaining === 0) {
        return 'cleared';
    }

    const overdueRows = rows.filter(r => {
        if ((r.status || '').toLowerCase() === 'paid') return false;
        const d = r.dueDate ? new Date(r.dueDate) : null;
        return d && !isNaN(d.getTime()) && d < today;
    });

    const last3Rows = rows.filter(r => {
        const d = r.dueDate ? new Date(r.dueDate) : null;
        return d && !isNaN(d.getTime()) && d >= threeMonthsAgo && d < today;
    });

    if (last3Rows.length >= 3) {
        const totalPaidInPeriod = last3Rows.reduce((s, r) => s + Number(r.paidAmount || 0), 0);
        const totalDueInPeriod = last3Rows.reduce((s, r) => s + Number(r.dueAmount || 0), 0);

        if (totalPaidInPeriod === 0) return 'defaulter';
        if (totalDueInPeriod > 0 && totalPaidInPeriod < totalDueInPeriod * 0.5) return 'blacklist';
    }

    if (overdueRows.length >= 2) return 'overdue';
    if (overdueRows.length === 1) return 'regular';
    return 'active';
}

/**
 * Picks a free `short_id` for a new installment ledger.
 *
 * The short id is the customer-facing ledger handle (it is what goes out in
 * the WATI ledger link and what /api/ledger/pdf/:shortId resolves), so it is
 * UNIQUE across the whole table. Deriving it from the IMEI's last 6 digits
 * gives a memorable value, but those 6 digits are NOT unique across devices —
 * two handsets from different batches collide routinely, and at a few
 * thousand ledgers the birthday bound makes a collision near-certain.
 *
 * Callers used to hand the raw last-6 straight to create/upsert, so a
 * collision raised P2002 and (in the delivery flow) got swallowed — the
 * delivery completed with no ledger at all. Check first and fall back to
 * random hex instead: a less pretty id beats a missing ledger.
 *
 * Not race-proof on its own — two concurrent deliveries can still pick the
 * same free id between the check and the write — so writers must also retry
 * the insert on P2002.
 */
async function generateLedgerShortId(imei, { excludeOrderId = null, attempts = 20 } = {}) {
    const digits = imei ? String(imei).replace(/\D/g, '') : '';
    let candidate = digits.length >= 6
        ? digits.slice(-6)
        : crypto.randomBytes(4).toString('hex').slice(0, 6);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const clash = await prisma.installmentLedger.findUnique({
            where: { short_id: candidate },
            select: { order_id: true },
        });
        // Re-running against the order that already owns this id is a no-op,
        // not a clash — matters for upsert-update and for repair reruns.
        if (!clash || (excludeOrderId && clash.order_id === excludeOrderId)) return candidate;
        candidate = crypto.randomBytes(4).toString('hex').slice(0, 6);
    }
    // Exhausted the short space; widen rather than fail.
    return crypto.randomBytes(8).toString('hex').slice(0, 12);
}

const addMonths = (date, n) => {
    const d = new Date(date);
    d.setMonth(d.getMonth() + n);
    return d;
};

/**
 * Builds the canonical ledger_rows array: row 0 is the advance (already paid
 * at delivery), rows 1..n are the monthly installments. `customLedger` (the
 * per-month date/amount overrides an officer can set at delivery) wins when
 * it covers exactly `totalMonths` rows, otherwise the plan's flat monthly
 * amount is spread over month-anniversaries of `startDate`.
 *
 * Shared by the delivery-completion flow and the admin ledger repair so a
 * rebuilt ledger is byte-for-byte the shape the delivery flow would have
 * produced.
 */
function buildLedgerRows({ advanceAmount, monthlyAmount, totalMonths, customLedger, startDate, feedbackLabel }) {
    const start = startDate ? new Date(startDate) : new Date();
    const rows = [{
        month: 0,
        label: 'Advance Payment',
        due_date: start,
        amount: parseFloat(advanceAmount || 0),
        status: 'paid',
        paid_at: start,
        payment_method: 'Cash',
        feedback: feedbackLabel,
    }];

    const useCustom = Array.isArray(customLedger) && customLedger.length === totalMonths;
    for (let i = 0; i < totalMonths; i += 1) {
        const override = useCustom ? customLedger[i] : null;
        rows.push({
            month: i + 1,
            label: `Month ${i + 1}`,
            due_date: override?.date ? new Date(override.date) : addMonths(start, i + 1),
            amount: (override && parseFloat(override.amount)) || parseFloat(monthlyAmount),
            status: 'pending',
            paid_at: null,
        });
    }

    return rows;
}

module.exports = {
    normalizeLedger,
    getNormalizedLedger,
    computeDueAndCurrent,
    classifyLedgerAccountStatus,
    generateLedgerShortId,
    buildLedgerRows
};
