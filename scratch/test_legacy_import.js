// One-off verification script for legacyImportController — calls the real
// controller function with synthetic (clearly-fake) rows, checks every part
// of the expected object graph got created correctly, then deletes
// everything it created so no synthetic data is left sitting in production.
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
  if (!superAdmin) throw new Error('No Super Admin user found to run the test as.');

  const uniqueSuffix = Date.now().toString().slice(-8);
  const rows = [
    {
      order_date: new Date('2026-06-04').toISOString(),
      bill_id: null,
      purchaser_name: 'TEST LEGACY CUSTOMER',
      purchaser_cnic: `9${uniqueSuffix}1`,
      purchaser_phone: `0300${uniqueSuffix}`,
      purchaser_address: 'FB AREA, KARACHI',
      item_price: 61500,
      item_model: 'ZTE V80 8/256',
      serial: `862484${uniqueSuffix}`,
      tenure_months: 12,
      advance: 6300,
      installment: 4600,
      grantor1_name: 'TEST GRANTOR ONE',
      grantor1_cnic: `4210${uniqueSuffix}1`,
      grantor1_phone: '03118959818',
      grantor2_name: 'TEST GRANTOR TWO',
      grantor2_cnic: `4220${uniqueSuffix}1`,
      grantor2_phone: '03118959819',
      pay1: 4600,
      pay2: 4600,
      pay3: '',
      pay4: '',
      remain: 61500 - 6300 - 4600 - 4600,
    },
  ];

  const officer = await prisma.user.findFirst({ where: { role: { name: 'Verification Officer' }, status: 'active' } });
  const req = { body: { rows, officer_id: officer.id }, user: { id: superAdmin.id } };
  const res = mockRes();
  await commitLegacyImport(req, res);
  console.log('Controller response:', JSON.stringify(res.body, null, 2));

  const result = res.body?.results?.[0];
  if (!result?.success) {
    console.error('IMPORT FAILED — nothing to verify/clean up.');
    return;
  }

  const orderId = result.order_id;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      customer: true,
      delivery: { include: { installment_ledger: { include: { consumer_numbers: true } } } },
      verification: { include: { purchaser: true, grantors: true } },
    },
  });

  console.log('\n--- VERIFICATION ---');
  console.log('Order:', order.order_ref, order.status, 'needs_media_upload:', order.needs_media_upload, 'needs_location:', order.needs_location);
  console.log('Customer:', order.customer?.name, order.customer?.cnic, order.customer?.mobile);
  console.log('Delivery:', !!order.delivery, order.delivery?.status);
  console.log('verification_officer_id === officer.id (not admin):', order.verification?.verification_officer_id === officer.id);
  console.log('delivery_agent_id === officer.id (not admin):', order.delivery?.delivery_agent_id === officer.id);
  console.log('InstallmentLedger rows:', order.delivery?.installment_ledger?.ledger_rows?.length);
  console.log('ConsumerNumbers:', order.delivery?.installment_ledger?.consumer_numbers?.map(c => c.consumer_number));
  console.log('Verification status:', order.verification?.status);
  console.log('Purchaser:', order.verification?.purchaser?.name, order.verification?.purchaser?.cnic_number);
  console.log('Grantors:', order.verification?.grantors?.map(g => `${g.grantor_number}:${g.name}`));

  const ledgerRows = order.delivery?.installment_ledger?.ledger_rows || [];
  const paidMonths = ledgerRows.filter(r => r.status === 'paid').length; // includes advance row
  console.log('Paid rows (incl. advance):', paidMonths, '(expected 3: advance + 2 installments)');

  // ── Cleanup — delete everything this test created, in FK-safe order ──
  console.log('\n--- CLEANUP ---');
  const ledgerId = order.delivery?.installment_ledger?.id;
  const deliveryId = order.delivery?.id;
  const verificationId = order.verification?.id;

  if (ledgerId) {
    await prisma.consumerNumber.deleteMany({ where: { ledger_id: ledgerId } });
    await prisma.installmentLedger.delete({ where: { id: ledgerId } });
  }
  if (deliveryId) await prisma.delivery.delete({ where: { id: deliveryId } });
  if (verificationId) {
    await prisma.grantorVerification.deleteMany({ where: { verification_id: verificationId } });
    await prisma.purchaserVerification.deleteMany({ where: { verification_id: verificationId } });
    await prisma.verification.delete({ where: { id: verificationId } });
  }
  await prisma.orderStatusHistory.deleteMany({ where: { order_id: orderId } });
  await prisma.order.delete({ where: { id: orderId } });
  if (order.customer) await prisma.customer.delete({ where: { id: order.customer.id } });

  console.log('Cleaned up test order', orderId, 'and related records.');
}

main().catch((e) => console.error('TEST ERROR', e)).finally(() => prisma.$disconnect());
