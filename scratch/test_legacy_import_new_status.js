// Verifies the default_status: 'new' branch (no Delivery/Ledger/ConsumerNumber
// created) and cleans up afterward, same approach as test_legacy_import.js.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { commitLegacyImport } = require('../src/controllers/legacyImportController');

function mockRes() {
  const res = { statusCode: 200 };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

async function main() {
  const superAdmin = await prisma.user.findFirst({ where: { role: { name: 'Super Admin' } } });
  const uniqueSuffix = Date.now().toString().slice(-8);
  const rows = [{
    order_date: new Date('2026-06-04').toISOString(),
    purchaser_name: 'TEST NEW STATUS CUSTOMER',
    purchaser_cnic: `8${uniqueSuffix}1`,
    purchaser_phone: `0311${uniqueSuffix}`,
    purchaser_address: 'GULSHAN, KARACHI',
    item_price: 50000,
    item_model: 'Test Model',
    serial: `999${uniqueSuffix}`,
    tenure_months: 10,
    advance: 5000,
    installment: 4500,
    grantor1_name: 'TEST GRANTOR NEW',
    grantor1_cnic: `4230${uniqueSuffix}1`,
    grantor1_phone: '03118959820',
    pay1: '', pay2: '', pay3: '', pay4: '',
    remain: 50000 - 5000,
  }];

  const req = { body: { rows, default_status: 'new' }, user: { id: superAdmin.id } };
  const res = mockRes();
  await commitLegacyImport(req, res);
  console.log('Response:', JSON.stringify(res.body, null, 2));

  const result = res.body?.results?.[0];
  if (!result?.success) { console.error('FAILED'); return; }

  const orderId = result.order_id;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { customer: true, delivery: true, verification: { include: { purchaser: true, grantors: true } } },
  });
  console.log('Order status:', order.status, 'is_delivered:', order.is_delivered, 'has delivery:', !!order.delivery);
  console.log('Verification status:', order.verification?.status);
  console.log('needs_media_upload:', order.needs_media_upload, 'needs_location:', order.needs_location);

  // Cleanup
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
