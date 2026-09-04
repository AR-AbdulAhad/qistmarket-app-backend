// Verifies the Assignment Timeline + Order Status Timeline backfill: every
// imported order should show a full, honest history on its detail page
// instead of just a bare "Order Created" card. Also checks the
// recovery_officer assignment is conditional on whether the row still has a
// pending balance. Cleans up after itself.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { commitLegacyImport } = require('../src/controllers/legacyImportController');

function mockRes() {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function importCleanupCheck(row, superAdminId) {
  const res = mockRes();
  await commitLegacyImport({ body: { rows: [row] }, user: { id: superAdminId } }, res);
  const result = res.body.results[0];
  if (!result.success) { console.error('IMPORT FAILED:', result.error); return; }
  const orderId = result.order_id;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      delivery: { include: { installment_ledger: true } },
      verification: true,
      statusHistories: { orderBy: { created_at: 'asc' } },
      assigned_to: { select: { full_name: true } },
      delivery_officer: { select: { full_name: true } },
      recovery_officer: { select: { full_name: true } },
    },
  });

  console.log(`\n=== Order ${orderId} (${order.customer_name}) ===`);
  console.log('status:', order.status, '(should be "delivered", never "completed")');
  console.log('assigned_to (VO):', order.assigned_to?.full_name, 'verification_assigned_at:', !!order.verification_assigned_at);
  console.log('delivery_officer:', order.delivery_officer?.full_name, 'delivery_assigned_at:', !!order.delivery_assigned_at);
  console.log('recovery_officer:', order.recovery_officer?.full_name || '(none)', 'recovery_assigned_at:', !!order.recovery_assigned_at);
  console.log('statusHistories count:', order.statusHistories.length, '(expect 5)');
  console.log('progression:', order.statusHistories.map(h => `${h.old_status || 'null'}->${h.new_status}`).join(', '));
  console.log('all attributed to importing admin:', order.statusHistories.every(h => h.user_id === superAdminId));
  console.log('first has remarks:', !!order.statusHistories[0]?.remarks);
  console.log('timestamps strictly increasing:', order.statusHistories.every((h, i) => i === 0 || new Date(h.created_at) > new Date(order.statusHistories[i - 1].created_at)));

  // Cleanup
  const ledgerId = order.delivery?.installment_ledger?.id;
  if (ledgerId) { await prisma.consumerNumber.deleteMany({ where: { ledger_id: ledgerId } }); await prisma.installmentLedger.delete({ where: { id: ledgerId } }); }
  if (order.delivery) await prisma.delivery.delete({ where: { id: order.delivery.id } });
  await prisma.grantorVerification.deleteMany({ where: { verification_id: order.verification.id } });
  await prisma.purchaserVerification.deleteMany({ where: { verification_id: order.verification.id } });
  await prisma.verification.delete({ where: { id: order.verification.id } });
  await prisma.orderStatusHistory.deleteMany({ where: { order_id: orderId } });
  await prisma.order.delete({ where: { id: orderId } });
  await prisma.customer.deleteMany({ where: { cnic: row.purchaser_cnic } });
}

async function main() {
  const superAdmin = await prisma.user.findFirst({ where: { role: { name: 'Super Admin' } } });
  const suf = Date.now().toString().slice(-8);

  // Row 1: still has a pending balance -> should get a recovery officer too.
  await importCleanupCheck({
    order_date: new Date('2026-06-04').toISOString(),
    purchaser_name: 'TEST TIMELINE ONGOING', purchaser_cnic: `1${suf}1`, purchaser_phone: `0399${suf}`,
    item_price: 61500, tenure_months: 12, advance: 6300, installment: 4600, remain: 46000,
  }, superAdmin.id);

  // Row 2: fully paid off (remain 0) -> should NOT get a recovery officer.
  await importCleanupCheck({
    order_date: new Date('2026-01-10').toISOString(),
    purchaser_name: 'TEST TIMELINE PAIDOFF', purchaser_cnic: `9${suf}2`, purchaser_phone: `0398${suf}`,
    item_price: 45300, tenure_months: 6, advance: 4800, installment: 6750, remain: 0,
  }, superAdmin.id);

  console.log('\nDone.');
}

main().catch((e) => console.error('TEST ERROR', e)).finally(() => prisma.$disconnect());
