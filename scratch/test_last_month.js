const { getNormalizedLedger } = require('../src/utils/ledgerUtils');

function getActivePayableIndex(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return -1;
    const today = new Date('2026-09-07T00:00:00.000Z');

    let activePayableIndex = rows.findIndex(r => {
        if (r.status === 'paid') return false;
        const m = r.monthNumber ?? r.month ?? 0;
        if (m <= 0) return false;
        const dueDate = r.dueDate || r.due_date;
        if (!dueDate) return true;
        const d = new Date(dueDate);
        if (isNaN(d.getTime())) return true;
        d.setHours(0, 0, 0, 0);
        return d >= today;
    });

    if (activePayableIndex === -1) {
        const unpaidIndices = rows
            .map((r, i) => ((r.monthNumber ?? r.month ?? 0) > 0 && r.status !== 'paid') ? i : -1)
            .filter(i => i !== -1);
        if (unpaidIndices.length > 0) activePayableIndex = unpaidIndices[unpaidIndices.length - 1];
    }

    return activePayableIndex;
}

// User's order 20260505-6905:
// M1: Due 06-Jun-26 -> Paid 7,800
// M2: Due 06-Jul-26 -> Partial (Paid 4,000, Remaining 3,800)
// M3: Due 06-Aug-26 -> Pending (Due 7,800)
const orderRows = [
    { month: 0, amount: 10500, status: 'paid' },
    { month: 1, due_date: '2026-06-06', amount: 7800, paid_amount: 7800, status: 'paid' },
    { month: 2, due_date: '2026-07-06', amount: 7800, paid_amount: 4000, status: 'partial' },
    { month: 3, due_date: '2026-08-06', amount: 7800, paid_amount: 0, status: 'pending' }
];

const normalized = getNormalizedLedger(orderRows, 10500);
console.log('--- Order 20260505-6905 Normalized Ledger ---');
for (const r of normalized.installment_ledger) {
    console.log(`M${r.monthNumber} | Due: ${r.dueDate} | Status: ${r.status} | Rem: ${r.remainingAmount} | Arrears: ${r.arrears}`);
}

const activeIdx = getActivePayableIndex(normalized.installment_ledger);
console.log('\nActive Payable Index:', activeIdx);
console.log('Active Payable Row:', normalized.installment_ledger[activeIdx]);
console.log('\nM2 status in UI:', activeIdx === 2 ? 'OPEN' : 'LOCKED');
console.log('M3 status in UI:', activeIdx === 3 ? 'OPEN' : 'LOCKED');
