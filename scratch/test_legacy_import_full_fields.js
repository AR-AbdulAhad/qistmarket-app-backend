// Verifies the expanded field set (purchaser employment/business info, full
// grantor profiles, structured address) actually lands in the DB correctly,
// and that fields left out of the row still fall back to the placeholder
// rather than erroring. Cleans up after itself.
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
  const suf = Date.now().toString().slice(-8);

  const row = {
    order_date: new Date('2026-06-04').toISOString(),
    purchaser_name: 'TEST FULL FIELDS', purchaser_cnic: `2${suf}1`, purchaser_phone: `0388${suf}`,
    purchaser_alt_contact: '03001234567', purchaser_city: 'Karachi', purchaser_area: 'FB Area',
    purchaser_zone: 'Central', purchaser_house_street: 'House 12, Street 4', purchaser_gender: 'Male',
    purchaser_residential_type: 'Owned', purchaser_father_husband_name: 'Ahsan Ali',
    purchaser_job_type: 'Salaried', purchaser_employer_name: 'ABC Textiles', purchaser_employer_address: 'SITE Karachi',
    purchaser_designation: 'Supervisor', purchaser_official_number: '02112345678', purchaser_gross_salary: '45000',
    purchaser_years_in_company: '5', purchaser_nearest_location: 'Near FB Area Chowrangi',
    // business fields deliberately left blank to test the orNull() path
    item_price: 61500, item_model: 'ZTE V80 8/256', serial: `86${suf}`, tenure_months: 12, advance: 6300, installment: 4600,
    grantor1_name: 'MATHEW EMMANUAL', grantor1_cnic: '42101-9237108-3', grantor1_phone: '03118959818',
    grantor1_father_husband_name: 'Emmanual Sr', grantor1_relationship: 'Friend', grantor1_job_type: 'Salaried',
    grantor1_designation: 'Manager', grantor1_office_address: 'Office Karachi', grantor1_company_name: 'XYZ Corp',
    grantor1_monthly_income: '60000', grantor1_nearest_location: 'Near office',
    // grantor2 left completely blank on purpose — tests the whole-guarantor-optional path still works
    remain: 46000,
  };

  const officer = await prisma.user.findFirst({ where: { role: { name: 'Verification Officer' }, status: 'active' } });
  const res = mockRes();
  await commitLegacyImport({ body: { rows: [row], officer_id: officer.id }, user: { id: superAdmin.id } }, res);
  console.log('Result:', JSON.stringify(res.body.results[0]));
  const orderId = res.body.results[0].order_id;
  if (!orderId) return;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      customer: true,
      delivery: { include: { installment_ledger: true } },
      verification: { include: { purchaser: true, grantors: true } },
    },
  });

  console.log('\n--- ORDER STRUCTURED ADDRESS ---');
  console.log('city:', order.city, 'area:', order.area, 'zone:', order.zone, 'house_no:', order.house_no, 'gender:', order.gender, 'residential_type:', order.residential_type, 'alternate_contact:', order.alternate_contact);

  const p = order.verification.purchaser;
  console.log('\n--- PURCHASER ---');
  console.log('father_husband_name:', p.father_husband_name, '(expect: Ahsan Ali)');
  console.log('employer_name:', p.employer_name, '(expect: ABC Textiles)');
  console.log('designation:', p.designation, '(expect: Supervisor)');
  console.log('gross_salary:', p.gross_salary, '(expect: 45000)');
  console.log('business_name (should be null, not placeholder):', p.business_name);
  console.log('employment_type (should be null, not default EMPLOYED):', p.employment_type);

  const g1 = order.verification.grantors.find(g => g.grantor_number === 1);
  console.log('\n--- GRANTOR 1 ---');
  console.log('relationship:', g1.relationship, '(expect: Friend)');
  console.log('company_name:', g1.company_name, '(expect: XYZ Corp)');
  console.log('office_address:', g1.office_address, '(expect: Office Karachi)');

  console.log('\ngrantor2 present (should be false — left blank in sheet):', order.verification.grantors.some(g => g.grantor_number === 2));

  // Cleanup
  const ledgerId = order.delivery?.installment_ledger?.id;
  if (ledgerId) { await prisma.consumerNumber.deleteMany({ where: { ledger_id: ledgerId } }); await prisma.installmentLedger.delete({ where: { id: ledgerId } }); }
  if (order.delivery) await prisma.delivery.delete({ where: { id: order.delivery.id } });
  await prisma.grantorVerification.deleteMany({ where: { verification_id: order.verification.id } });
  await prisma.purchaserVerification.deleteMany({ where: { verification_id: order.verification.id } });
  await prisma.verification.delete({ where: { id: order.verification.id } });
  await prisma.orderStatusHistory.deleteMany({ where: { order_id: orderId } });
  await prisma.order.delete({ where: { id: orderId } });
  if (order.customer) await prisma.customer.delete({ where: { id: order.customer.id } });
  console.log('\nCleaned up.');
}

main().catch((e) => console.error('TEST ERROR', e)).finally(() => prisma.$disconnect());
