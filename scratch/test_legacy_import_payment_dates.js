// Verifies per-payment amount + date accuracy: PAY1-4 real amounts/dates
// should land on the matching ledger row's paid_amount/paid_at exactly,
// even when a payment is uneven (not equal to the flat monthly installment)
// — not just inferred as "N months paid, each for the scheduled amount on a
// fabricated date". Cleans up after itself.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { commitLegacyImport } = require('../src/controllers/legacyImportController');

function mockRes() {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function main() {
  const superAdmin = await prisma.user.findFirst({ where: { role: { name: 'Super Admin' } } });
  const officer = await prisma.user.findFirst({ where: { role: { name: 'Verification Officer' }, status: 'active' } });
  const suf = Date.now().toString().slice(-8);

  // Installment is 4600/month, but PAY1 was a slightly short/partial payment
  // (4000) and PAY2 was paid in full (4600) on specific real dates — remain
  // still correctly reflects (61500 - 6300 - 4000 - 4600) since remain is
  // authoritative for the *count* of paid months, while the real PAY
  // figures should still drive the per-row paid_amount/paid_at.
  const row = {
    order_date: new Date('2026-06-04').toISOString(),
    purchaser_name: 'TEST PAYMENT DATES', purchaser_cnic: `8${suf}1`, purchaser_phone: `0311${suf}`,
    item_price: 61500, item_model: 'ZTE V80 8/256', serial: `77${suf}`, tenure_months: 12, advance: 6300, installment: 4600,
    pay1: 4000, pay1_date: new Date('2026-07-10').toISOString(),
    pay2: 4600, pay2_date: new Date('2026-08-12').toISOString(),
    remain: 61500 - 6300 - 4000 - 4600,
  };

  const res = mockRes();
  await commitLegacyImport({ body: { rows: [row], officer_id: officer.id }, user: { id: superAdmin.id } }, res);
  const result = res.body.results[0];
  console.log('Result:', JSON.stringify(result));
  if (!result.success) return;

  const order = await prisma.order.findUnique({
    where: { id: result.order_id },
    include: { customer: true, delivery: { include: { installment_ledger: true } }, verification: true },
  });
  const rows = order.delivery.installment_ledger.ledger_rows;
  const m1 = rows.find(r => r.month === 1);
  const m2 = rows.find(r => r.month === 2);
  const m3 = rows.find(r => r.month === 3);

  console.log('\nMonth 1: amount(due)=', m1.amount, 'paid_amount=', m1.paid_amount, '(expect 4000, NOT 4600)', 'paid_at=', m1.paid_at, '(expect 2026-07-10)');
  console.log('Month 2: amount(due)=', m2.amount, 'paid_amount=', m2.paid_amount, '(expect 4600)', 'paid_at=', m2.paid_at, '(expect 2026-08-12)');
  console.log('Month 3 status (should be pending, no 3rd real payment given):', m3.status);

  const okAmount1 = m1.paid_amount === 4000;
  const okDate1 = new Date(m1.paid_at).toISOString().slice(0, 10) === '2026-07-10';
  const okAmount2 = m2.paid_amount === 4600;
  const okDate2 = new Date(m2.paid_at).toISOString().slice(0, 10) === '2026-08-12';
  console.log('\nAll checks pass:', okAmount1 && okDate1 && okAmount2 && okDate2);

  // Cleanup
  const ledgerId = order.delivery?.installment_ledger?.id;
  if (ledgerId) { await prisma.consumerNumber.deleteMany({ where: { ledger_id: ledgerId } }); await prisma.installmentLedger.delete({ where: { id: ledgerId } }); }
  if (order.delivery) await prisma.delivery.delete({ where: { id: order.delivery.id } });
  await prisma.grantorVerification.deleteMany({ where: { verification_id: order.verification.id } });
  await prisma.purchaserVerification.deleteMany({ where: { verification_id: order.verification.id } });
  await prisma.verification.delete({ where: { id: order.verification.id } });
  await prisma.orderStatusHistory.deleteMany({ where: { order_id: order.id } });
  await prisma.order.delete({ where: { id: order.id } });
  await prisma.customer.deleteMany({ where: { cnic: row.purchaser_cnic } });
  console.log('Cleaned up.');
}

main().catch((e) => console.error('TEST ERROR', e)).finally(() => prisma.$disconnect());
