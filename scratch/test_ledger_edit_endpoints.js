// Verifies the two new Super-Admin-only ledger endpoints, using the EXACT
// payload shape the real frontend sends (this matters: an earlier version of
// this test sent the raw ledger_rows array including month 0/advance, which
// masked a real bug — PaymentDetailsSection.tsx's editable table only ever
// covers the Installment Schedule (month > 0), since Advance Payment has its
// own separate, non-editable display block above it. The backend originally
// compared against the FULL raw array (including month 0), so a real Save
// always tripped "Row count mismatch" in production. Fixed in
// ledgerController.js's editLedgerRows: it now splits off the advance row,
// compares/replaces only the month>0 rows, and reattaches the advance row
// untouched. This test reproduces the frontend's exact request shape so a
// regression here would be caught the same way it was found (by hand, via a
// real screenshot) if this test hadn't been fixed to match.
//
// - PATCH /ledger/:ledger_id/edit (editLedgerRows) — direct field edit on
//   month>0 rows only, advance row (month 0) always left untouched,
//   server-recomputed status, payment_history tagging on hand-changed
//   paid_amount, row-count-mismatch rejection, non-Super-Admin rejection.
// - POST /ledger/:ledger_id/set-months (setLedgerMonths) — month-count
//   increase/decrease, rejection when shrinking below paid count, amount
//   redistribution + rounding-remainder-on-last-row, arrears still work
//   afterward via the existing normalizeLedger (no new code needed there).
// Builds a real ledger via the existing legacy-import path, then exercises
// both endpoints against it. Cleans up everything it creates.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { commitLegacyImport } = require('../src/controllers/legacyImportController');
const { editLedgerRows, setLedgerMonths } = require('../src/controllers/ledgerController');
const { normalizeLedger, getNormalizedLedger } = require('../src/utils/ledgerUtils');

function mockRes() {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

// Mirrors PaymentDetailsSection.tsx's startEdit(): builds the editable-row
// array from the NORMALIZED installments list (month > 0 only), exactly what
// the browser actually sends on Save — never the raw ledger_rows.
function buildFrontendEditPayload(rawRows, mutate) {
  const normalized = getNormalizedLedger(rawRows);
  const rows = normalized.installment_ledger.map((inst) => ({
    month: inst.monthNumber,
    label: inst.label,
    due_date: inst.dueDate ? new Date(inst.dueDate).toISOString().slice(0, 10) : '',
    amount: String(inst.dueAmount ?? 0),
    paid_amount: String(inst.paidAmount ?? 0),
    payment_method: inst.paymentMethod || '',
  }));
  const mutated = mutate ? rows.map(mutate) : rows;
  // The real component sends amount/paid_amount parsed back to numbers on submit.
  return mutated.map((r) => ({
    month: r.month,
    label: r.label,
    due_date: r.due_date,
    amount: parseFloat(r.amount) || 0,
    paid_amount: parseFloat(r.paid_amount) || 0,
    payment_method: r.payment_method || null,
  }));
}

async function main() {
  const superAdmin = await prisma.user.findFirst({ where: { role: { name: 'Super Admin' } } });
  const someNonAdmin = await prisma.user.findFirst({ where: { role: { name: { not: 'Super Admin' } }, status: 'active' } });
  const suf = Date.now().toString().slice(-8);

  // Build a real ledger: 12 months, 3 already paid (via remain-based paidCount).
  const row = {
    order_date: new Date('2026-01-04').toISOString(),
    purchaser_name: 'TEST LEDGER EDIT', purchaser_cnic: `7${suf}1`, purchaser_phone: `0399${suf}`,
    item_price: 61200, item_model: 'TEST MODEL', serial: `LE${suf}`, tenure_months: 12, advance: 6000, installment: 4600,
    remain: 55200 - 3 * 4600, // exactly 3 months paid
  };

  const importRes = mockRes();
  await commitLegacyImport({ body: { rows: [row] }, user: { id: superAdmin.id } }, importRes);
  const result = importRes.body.results[0];
  if (!result.success) { console.error('SETUP FAILED:', result.error); return; }

  const order = await prisma.order.findUnique({
    where: { id: result.order_id },
    include: { delivery: { include: { installment_ledger: true } } },
  });
  const ledgerId = order.delivery.installment_ledger.id;
  console.log('Created test ledger', ledgerId, 'for order', order.id);

  const initialRawRows = order.delivery.installment_ledger.ledger_rows;
  const initialAdvanceRow = initialRawRows.find((r) => r.month === 0);
  console.log('Initial raw row count (incl. advance):', initialRawRows.length);
  console.log('Initial months paid =', initialRawRows.filter(r => r.month > 0 && r.status === 'paid').length, '/ 12');

  // ---- Test 1: non-Super-Admin rejected ----
  console.log('\n--- Test 1: non-Super-Admin rejected on editLedgerRows ---');
  const payload1 = buildFrontendEditPayload(initialRawRows);
  const res1 = mockRes();
  await editLedgerRows({ params: { ledger_id: ledgerId }, body: { rows: payload1 }, user: { id: someNonAdmin?.id || 9999, role: someNonAdmin?.role?.name || 'Verification Officer' } }, res1);
  console.log('Status (expect 403):', res1.statusCode, res1.body.message);

  // ---- Test 2: THE REAL BUG — frontend's actual payload (no month 0) must NOT trip row-count mismatch ----
  console.log('\n--- Test 2: real frontend payload (month>0 only) must succeed, not "row count mismatch" ---');
  const payload2 = buildFrontendEditPayload(initialRawRows);
  console.log('Frontend payload row count (expect 12, no advance row):', payload2.length);
  const res2 = mockRes();
  await editLedgerRows({ params: { ledger_id: ledgerId }, body: { rows: payload2 }, user: { id: superAdmin.id, role: 'Super Admin', full_name: 'Test SA' } }, res2);
  console.log('Status (expect 200, NOT 400 row-count-mismatch):', res2.statusCode, res2.body.message);
  if (res2.statusCode !== 200) { console.error('BUG STILL PRESENT — the exact production failure reproduced.'); }
  const advanceAfterNoOpSave = res2.body.data.ledger_rows.find((r) => r.month === 0);
  console.log('Advance row untouched after a no-op Installment-Schedule save:', JSON.stringify(advanceAfterNoOpSave) === JSON.stringify(initialAdvanceRow));

  // ---- Test 3: genuine row-count mismatch (wrong number of installment rows) still rejected ----
  console.log('\n--- Test 3: genuine row-count mismatch still rejected ---');
  const res3 = mockRes();
  await editLedgerRows({ params: { ledger_id: ledgerId }, body: { rows: payload2.slice(0, 5) }, user: { id: superAdmin.id, role: 'Super Admin' } }, res3);
  console.log('Status (expect 400):', res3.statusCode, res3.body.message);

  // ---- Test 4: direct edit — mark month 4 as paid by hand, via real frontend payload shape ----
  console.log('\n--- Test 4: direct edit — pay month 4 by hand (frontend payload shape) ---');
  const rowsAfterTest2 = res2.body.data.ledger_rows;
  const payload4 = buildFrontendEditPayload(rowsAfterTest2, (r) => (r.month === 4 ? { ...r, paid_amount: r.amount, payment_method: 'Bank Transfer' } : r));
  const res4 = mockRes();
  await editLedgerRows({ params: { ledger_id: ledgerId }, body: { rows: payload4 }, user: { id: superAdmin.id, role: 'Super Admin', full_name: 'Test SA' } }, res4);
  console.log('Status (expect 200):', res4.statusCode, res4.body.message);
  const month4 = res4.body.data.ledger_rows.find((r) => r.month === 4);
  console.log('Month 4 after edit:', { status: month4.status, paid_amount: month4.paid_amount, collection_source: month4.collection_source, payment_history: month4.payment_history });
  const advanceAfterRealEdit = res4.body.data.ledger_rows.find((r) => r.month === 0);
  console.log('Advance row still untouched after editing month 4:', JSON.stringify(advanceAfterRealEdit) === JSON.stringify(initialAdvanceRow));

  // ---- Test 5: editing amount only (no paid_amount change) doesn't touch payment_history ----
  console.log('\n--- Test 5: amount-only edit leaves payment_history alone for untouched rows ---');
  const rowsAfterTest4 = res4.body.data.ledger_rows;
  const payload5 = buildFrontendEditPayload(rowsAfterTest4, (r) => (r.month === 8 ? { ...r, amount: '4700' } : r));
  const res5 = mockRes();
  await editLedgerRows({ params: { ledger_id: ledgerId }, body: { rows: payload5 }, user: { id: superAdmin.id, role: 'Super Admin', full_name: 'Test SA' } }, res5);
  console.log('Status (expect 200):', res5.statusCode, res5.body.message);
  const month8 = res5.body.data.ledger_rows.find((r) => r.month === 8);
  console.log('Month 8 after amount-only edit:', { amount: month8.amount, status: month8.status, has_admin_edit_history: !!month8.collection_source });

  // ---- Test 6: set-months — reject shrinking below paid+partial count ----
  console.log('\n--- Test 6: set-months rejects shrinking below paid count ---');
  const res6 = mockRes();
  await setLedgerMonths({ params: { ledger_id: ledgerId }, body: { months: 3 }, user: { id: superAdmin.id, role: 'Super Admin', full_name: 'Test SA' } }, res6);
  console.log('Status (expect 400, since month 4 is now paid too):', res6.statusCode, res6.body.message);

  // ---- Test 7: set-months — increase from 12 to 15 ----
  console.log('\n--- Test 7: set-months increase 12 -> 15 ---');
  const res7 = mockRes();
  await setLedgerMonths({ params: { ledger_id: ledgerId }, body: { months: 15 }, user: { id: superAdmin.id, role: 'Super Admin', full_name: 'Test SA' } }, res7);
  console.log('Status (expect 200):', res7.statusCode, res7.body.message);
  const rows7 = res7.body.data.ledger_rows;
  console.log('Total rows (expect 16 incl advance):', rows7.length);
  console.log('Paid/partial months untouched:', rows7.filter(r => r.month > 0 && (r.status === 'paid')).map(r => r.month));
  const pendingRows7 = rows7.filter(r => r.status === 'pending');
  console.log('Pending months:', pendingRows7.map(r => r.month), 'amounts:', pendingRows7.map(r => r.amount));
  console.log('Sum of pending amounts (should equal remaining balance):', pendingRows7.reduce((s, r) => s + r.amount, 0));

  // ---- Test 8: arrears still compute correctly via normalizeLedger with no new code ----
  console.log('\n--- Test 8: normalizeLedger still works on edited/regenerated rows ---');
  const normalized = normalizeLedger(rows7);
  console.log('Sample normalized row (month 10):', JSON.stringify(normalized.find(r => r.month === 10)));

  // ---- Test 9: set-months decrease back down (still above paid count), then a real frontend edit right after ----
  console.log('\n--- Test 9: set-months decrease 15 -> 10, then a follow-up direct edit still works (no stale-shape issue) ---');
  const res9 = mockRes();
  await setLedgerMonths({ params: { ledger_id: ledgerId }, body: { months: 10 }, user: { id: superAdmin.id, role: 'Super Admin', full_name: 'Test SA' } }, res9);
  console.log('Status (expect 200):', res9.statusCode, res9.body.message);
  console.log('Total rows (expect 11 incl advance):', res9.body.data.ledger_rows.length);

  const payload9 = buildFrontendEditPayload(res9.body.data.ledger_rows);
  const res9b = mockRes();
  await editLedgerRows({ params: { ledger_id: ledgerId }, body: { rows: payload9 }, user: { id: superAdmin.id, role: 'Super Admin', full_name: 'Test SA' } }, res9b);
  console.log('Follow-up no-op edit after set-months, status (expect 200):', res9b.statusCode, res9b.body.message);

  // Cleanup
  await prisma.consumerNumber.deleteMany({ where: { ledger_id: ledgerId } });
  await prisma.installmentLedger.delete({ where: { id: ledgerId } });
  await prisma.delivery.delete({ where: { id: order.delivery.id } });
  const verification = await prisma.verification.findUnique({ where: { order_id: order.id } });
  if (verification) {
    await prisma.grantorVerification.deleteMany({ where: { verification_id: verification.id } });
    await prisma.purchaserVerification.deleteMany({ where: { verification_id: verification.id } });
    await prisma.verification.delete({ where: { id: verification.id } });
  }
  await prisma.securityLog.deleteMany({ where: { target_id: order.id, target_type: 'Order' } });
  await prisma.orderStatusHistory.deleteMany({ where: { order_id: order.id } });
  await prisma.order.delete({ where: { id: order.id } });
  await prisma.customer.deleteMany({ where: { cnic: row.purchaser_cnic } });
  console.log('\nCleaned up.');
}

main()
  .catch((e) => console.error('TEST ERROR', e))
  .finally(() => prisma.$disconnect());
