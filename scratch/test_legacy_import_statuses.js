// Verifies: (1) remain is authoritative for paidCount even when it doesn't
// match a whole number of PAY columns, (2) the newly-added statuses
// ('completed', 'cancelled') work end to end. Cleans up after itself.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { commitLegacyImport } = require('../src/controllers/legacyImportController');

function mockRes() {
  const res = { statusCode: 200 };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

async function importAndCheck(row, defaultStatus, superAdminId) {
  const res = mockRes();
  await commitLegacyImport({ body: { rows: [row], default_status: defaultStatus }, user: { id: superAdminId } }, res);
  const result = res.body?.results?.[0];
  console.log(`[${defaultStatus}] result:`, JSON.stringify(result));
  if (!result?.success) return null;
  const order = await prisma.order.findUnique({
    where: { id: result.order_id },
    include: { customer: true, delivery: { include: { installment_ledger: true } }, verification: true },
  });
  return order;
}

async function cleanup(order) {
  if (!order) return;
  const ledgerId = order.delivery?.installment_ledger?.id;
  if (ledgerId) {
    await prisma.consumerNumber.deleteMany({ where: { ledger_id: ledgerId } });
    await prisma.installmentLedger.delete({ where: { id: ledgerId } });
  }
  if (order.delivery) await prisma.delivery.delete({ where: { id: order.delivery.id } });
  if (order.verification) {
    await prisma.grantorVerification.deleteMany({ where: { verification_id: order.verification.id } });
    await prisma.purchaserVerification.deleteMany({ where: { verification_id: order.verification.id } });
    await prisma.verification.delete({ where: { id: order.verification.id } });
  }
  await prisma.orderStatusHistory.deleteMany({ where: { order_id: order.id } });
  await prisma.order.delete({ where: { id: order.id } });
  if (order.customer) await prisma.customer.delete({ where: { id: order.customer.id } });
}

async function main() {
  const superAdmin = await prisma.user.findFirst({ where: { role: { name: 'Super Admin' } } });

  // ── 1. remain authoritative, PAY columns entirely blank ──
  const suf1 = Date.now().toString().slice(-8);
  const row1 = {
    purchaser_name: 'TEST REMAIN AUTH', purchaser_cnic: `6${suf1}1`, purchaser_phone: `0344${suf1}`,
    item_price: 61500, item_model: 'ZTE V80 8/256', serial: `862${suf1}`, tenure_months: 12, advance: 6300, installment: 4600,
    pay1: '', pay2: '', pay3: '', pay4: '', remain: 46000, // matches the real ADNAN AHSAN row from the client's sheet
  };
  const order1 = await importAndCheck(row1, 'delivered', superAdmin.id);
  const rows1 = order1.delivery.installment_ledger.ledger_rows;
  const paidMonths1 = rows1.filter(r => r.status === 'paid').length;
  const finalRemain1 = row1.item_price - row1.advance - (paidMonths1 - 1) * row1.installment; // -1 for the advance row itself
  console.log('Paid rows (incl advance):', paidMonths1, '-> implied remain:', finalRemain1, '(sheet said 46000)');
  await cleanup(order1);

  // ── 2. status: completed ──
  const suf2 = Date.now().toString().slice(-8) + '9';
  const row2 = {
    purchaser_name: 'TEST COMPLETED STATUS', purchaser_cnic: `5${suf2}1`, purchaser_phone: `0355${suf2}`,
    item_price: 30000, item_model: 'Test Model', serial: `777${suf2}`, tenure_months: 6, advance: 3000, installment: 4500, remain: 0,
  };
  const order2 = await importAndCheck(row2, 'completed', superAdmin.id);
  console.log('order2 status:', order2.status, 'is_delivered:', order2.is_delivered, 'verification status:', order2.verification.status, 'has delivery:', !!order2.delivery);
  await cleanup(order2);

  // ── 3. status: cancelled ──
  const suf3 = Date.now().toString().slice(-8) + '8';
  const row3 = {
    purchaser_name: 'TEST CANCELLED STATUS', purchaser_cnic: `4${suf3}1`, purchaser_phone: `0366${suf3}`,
    item_price: 25000, item_model: 'Test Model 2', tenure_months: 6, advance: 2500, installment: 3750,
  };
  const order3 = await importAndCheck(row3, 'cancelled', superAdmin.id);
  console.log('order3 status:', order3.status, 'cancelled_reason:', order3.cancelled_reason, 'has delivery:', !!order3.delivery);
  await cleanup(order3);

  // ── 4. invalid status rejected ──
  const res4 = mockRes();
  await commitLegacyImport({ body: { rows: [row3], default_status: 'picked' }, user: { id: superAdmin.id } }, res4);
  console.log('4. invalid status ("picked") ->', res4.statusCode, res4.body.message);

  console.log('\nAll cleaned up.');
}

main().catch((e) => console.error('TEST ERROR', e)).finally(() => prisma.$disconnect());
