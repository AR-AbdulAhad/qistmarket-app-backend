// Covers: (1) a row missing required fields is rejected cleanly with no
// records created, (2) listPendingLegacyProfiles finds an imported order,
// (3) markLegacyProfileComplete clears both flags. Cleans up after itself.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { commitLegacyImport, listPendingLegacyProfiles, markLegacyProfileComplete } = require('../src/controllers/legacyImportController');

function mockRes() {
  const res = { statusCode: 200 };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

async function main() {
  const superAdmin = await prisma.user.findFirst({ where: { role: { name: 'Super Admin' } } });
  const uniqueSuffix = Date.now().toString().slice(-8);

  // ── 1. Missing required fields ──
  const badRow = { purchaser_name: 'NO CNIC PERSON', item_price: 1000 }; // missing cnic/phone/tenure/installment
  let res1 = mockRes();
  await commitLegacyImport({ body: { rows: [badRow], default_status: 'delivered' }, user: { id: superAdmin.id } }, res1);
  console.log('1. Bad row result:', JSON.stringify(res1.body.results[0]));
  const leaked = await prisma.order.findFirst({ where: { customer_name: 'NO CNIC PERSON' } });
  console.log('   leaked order (should be null):', leaked);

  // ── 2 & 3. Import one valid row, confirm it shows in pending list, mark complete ──
  const goodRow = {
    purchaser_name: 'TEST MISC CUSTOMER', purchaser_cnic: `7${uniqueSuffix}1`, purchaser_phone: `0333${uniqueSuffix}`,
    item_price: 40000, item_model: 'Misc Model', serial: `111${uniqueSuffix}`, tenure_months: 6, advance: 4000, installment: 6000,
  };
  let res2 = mockRes();
  await commitLegacyImport({ body: { rows: [goodRow], default_status: 'delivered' }, user: { id: superAdmin.id } }, res2);
  const orderId = res2.body.results[0].order_id;
  console.log('2. Imported order id:', orderId);

  let res3 = mockRes();
  await listPendingLegacyProfiles({}, res3);
  const found = res3.body.data.find((o) => o.id === orderId);
  console.log('3. Found in pending list:', !!found, found ? { needs_media_upload: found.needs_media_upload, needs_location: found.needs_location } : null);

  let res4 = mockRes();
  await markLegacyProfileComplete({ params: { orderId: String(orderId) } }, res4);
  console.log('4. mark-complete response:', JSON.stringify(res4.body));

  const after = await prisma.order.findUnique({ where: { id: orderId }, select: { needs_media_upload: true, needs_location: true } });
  console.log('   flags after mark-complete:', after);

  let res5 = mockRes();
  await listPendingLegacyProfiles({}, res5);
  console.log('5. Still in pending list after mark-complete (should be false):', res5.body.data.some((o) => o.id === orderId));

  // Cleanup
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { customer: true, delivery: { include: { installment_ledger: true } }, verification: true },
  });
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
  await prisma.orderStatusHistory.deleteMany({ where: { order_id: orderId } });
  await prisma.order.delete({ where: { id: orderId } });
  if (order.customer) await prisma.customer.delete({ where: { id: order.customer.id } });
  console.log('Cleaned up.');
}

main().catch((e) => console.error('TEST ERROR', e)).finally(() => prisma.$disconnect());
