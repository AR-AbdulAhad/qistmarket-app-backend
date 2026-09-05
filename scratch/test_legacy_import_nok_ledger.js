// Verifies (1) Next of Kin gets created when the sheet has one, and stays
// absent when it doesn't, and (2) paid ledger rows now carry
// payment_history/collection_source/fuel_charges matching a normal row's
// shape. Cleans up after itself.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { commitLegacyImport } = require('../src/controllers/legacyImportController');

function mockRes() {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function importAndCleanup(row) {
  const superAdmin = await prisma.user.findFirst({ where: { role: { name: 'Super Admin' } } });
  const res = mockRes();
  await commitLegacyImport({ body: { rows: [row] }, user: { id: superAdmin.id } }, res);
  const result = res.body.results[0];
  if (!result.success) { console.error('IMPORT FAILED:', result.error); return null; }

  const order = await prisma.order.findUnique({
    where: { id: result.order_id },
    include: {
      customer: true,
      delivery: { include: { installment_ledger: true } },
      verification: { include: { nextOfKin: true } },
    },
  });
  return order;
}

async function cleanup(order) {
  const ledgerId = order.delivery?.installment_ledger?.id;
  if (ledgerId) { await prisma.consumerNumber.deleteMany({ where: { ledger_id: ledgerId } }); await prisma.installmentLedger.delete({ where: { id: ledgerId } }); }
  if (order.delivery) await prisma.delivery.delete({ where: { id: order.delivery.id } });
  if (order.verification?.nextOfKin) await prisma.nextOfKinVerification.delete({ where: { id: order.verification.nextOfKin.id } });
  await prisma.grantorVerification.deleteMany({ where: { verification_id: order.verification.id } });
  await prisma.purchaserVerification.deleteMany({ where: { verification_id: order.verification.id } });
  await prisma.verification.delete({ where: { id: order.verification.id } });
  await prisma.orderStatusHistory.deleteMany({ where: { order_id: order.id } });
  await prisma.order.delete({ where: { id: order.id } });
  if (order.customer) await prisma.customer.delete({ where: { id: order.customer.id } });
}

async function main() {
  const suf = Date.now().toString().slice(-8);

  // Row with a Next of Kin.
  const rowWithNok = {
    order_date: new Date('2026-06-04').toISOString(),
    purchaser_name: 'TEST NOK CUSTOMER', purchaser_cnic: `3${suf}1`, purchaser_phone: `0344${suf}`,
    item_price: 61500, tenure_months: 12, advance: 6300, installment: 4600, remain: 46000,
    next_of_kin_name: 'Ahsan Brother', next_of_kin_cnic: '42101-1111111-1', next_of_kin_relation: 'Brother', next_of_kin_phone: '03001112222',
  };
  const order1 = await importAndCleanup(rowWithNok);
  console.log('--- Row WITH Next of Kin ---');
  console.log('nextOfKin:', order1.verification.nextOfKin);

  const ledgerRows1 = order1.delivery.installment_ledger.ledger_rows;
  const advanceRow = ledgerRows1.find(r => r.month === 0);
  const paidMonth1 = ledgerRows1.find(r => r.month === 1);
  const pendingMonth = ledgerRows1.find(r => r.status === 'pending');
  console.log('\nAdvance row extras:', { payment_history: advanceRow.payment_history, collection_source: advanceRow.collection_source, fuel_charges: advanceRow.fuel_charges });
  console.log('Paid month 1 extras:', { payment_history: paidMonth1.payment_history, collection_source: paidMonth1.collection_source, fuel_charges: paidMonth1.fuel_charges });
  console.log('Pending month has no payment_history (expected undefined):', pendingMonth.payment_history);
  await cleanup(order1);

  // Row WITHOUT a Next of Kin — should simply have none, no error.
  const rowNoNok = {
    order_date: new Date('2026-06-04').toISOString(),
    purchaser_name: 'TEST NO NOK CUSTOMER', purchaser_cnic: `2${suf}2`, purchaser_phone: `0355${suf}`,
    item_price: 45300, tenure_months: 6, advance: 4800, installment: 6750, remain: 0,
  };
  const order2 = await importAndCleanup(rowNoNok);
  console.log('\n--- Row WITHOUT Next of Kin ---');
  console.log('nextOfKin (should be null):', order2.verification.nextOfKin);
  await cleanup(order2);

  console.log('\nCleaned up.');
}

main().catch((e) => console.error('TEST ERROR', e)).finally(() => prisma.$disconnect());
