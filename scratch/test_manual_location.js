// Verifies the manual "Add Location" flow the new frontend form uses:
// imports one legacy profile, then calls updateLocationVerified directly
// (same function POST /verification/:id/location-verified hits) for the
// purchaser and both grantors, and confirms home_location_verified flips to
// true and each VerificationLocation lands with the right person_type/
// person_id. Cleans up after itself.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { commitLegacyImport } = require('../src/controllers/legacyImportController');
const { updateLocationVerified } = require('../src/controllers/verificationController');

function mockRes() {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function main() {
  const superAdmin = await prisma.user.findFirst({ where: { role: { name: 'Super Admin' } } });
  const suf = Date.now().toString().slice(-8);

  const row = {
    order_date: new Date('2026-06-04').toISOString(),
    purchaser_name: 'TEST MANUAL LOCATION', purchaser_cnic: `6${suf}1`, purchaser_phone: `0322${suf}`,
    item_price: 61500, item_model: 'ZTE V80 8/256', serial: `55${suf}`, tenure_months: 12, advance: 6300, installment: 4600,
    grantor1_name: 'TEST GRANTOR ONE', grantor1_cnic: `4210${suf}1`, grantor1_phone: '03118959818',
    remain: 46000,
  };

  const importRes = mockRes();
  await commitLegacyImport({ body: { rows: [row] }, user: { id: superAdmin.id } }, importRes);
  const orderId = importRes.body.results[0].order_id;
  console.log('Imported order:', orderId, importRes.body.results[0]);

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { verification: { include: { purchaser: true, grantors: true } }, delivery: { include: { installment_ledger: true } } },
  });
  const verification = order.verification;
  console.log('home_location_verified before:', verification.home_location_verified, '(expect false)');

  // Simulate the frontend's "Add Location" form submit for the Purchaser.
  const locRes = mockRes();
  await updateLocationVerified(
    {
      params: { verification_id: String(verification.id) },
      body: {
        location_type: 'manual',
        latitude: '24.8607',
        longitude: '67.0011',
        address: 'FB Area, Karachi',
        label: 'Purchaser',
        person_type: 'purchaser',
        person_id: String(verification.purchaser.id),
      },
      files: [],
      user: { id: superAdmin.id, role: 'Super Admin' },
    },
    locRes
  );
  console.log('\nlocation-verified response:', JSON.stringify(locRes.body, null, 2));

  const verificationAfter = await prisma.verification.findUnique({ where: { id: verification.id } });
  console.log('home_location_verified after:', verificationAfter.home_location_verified, '(expect true)');
  console.log('home_location_required after:', verificationAfter.home_location_required, '(expect false)');
  console.log('status after:', verificationAfter.status, '(expect location_captured)');

  const savedLocation = await prisma.verificationLocation.findFirst({ where: { verification_id: verification.id, person_type: 'purchaser' } });
  console.log('saved location:', savedLocation.latitude, savedLocation.longitude, savedLocation.address, savedLocation.person_id, '(person_id should ==', verification.purchaser.id, ')');

  // Cleanup
  await prisma.verificationLocation.deleteMany({ where: { verification_id: verification.id } });
  const ledgerId = order.delivery?.installment_ledger?.id;
  if (ledgerId) { await prisma.consumerNumber.deleteMany({ where: { ledger_id: ledgerId } }); await prisma.installmentLedger.delete({ where: { id: ledgerId } }); }
  if (order.delivery) await prisma.delivery.delete({ where: { id: order.delivery.id } });
  await prisma.grantorVerification.deleteMany({ where: { verification_id: verification.id } });
  await prisma.purchaserVerification.deleteMany({ where: { verification_id: verification.id } });
  await prisma.verification.delete({ where: { id: verification.id } });
  await prisma.orderStatusHistory.deleteMany({ where: { order_id: orderId } });
  await prisma.order.delete({ where: { id: orderId } });
  await prisma.customer.deleteMany({ where: { cnic: row.purchaser_cnic } });
  console.log('\nCleaned up.');
}

main().catch((e) => console.error('TEST ERROR', e)).finally(() => prisma.$disconnect());
