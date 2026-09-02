const prisma = require('../lib/prisma');
const { deleteOrderPermanently } = require('../src/controllers/adminPanelController');

async function testDeletion() {
  console.log('--- CREATING DUMMY ORDER FOR DELETION TEST ---');
  const timestamp = Date.now();
  const testPhone = `0399${String(timestamp).slice(-7)}`;
  const testCnic = `99999-${String(timestamp).slice(-7)}-1`;

  // 1. Create dummy customer
  const customer = await prisma.customer.create({
    data: {
      name: 'TEST DELETE CUSTOMER',
      cnic: testCnic,
      mobile: testPhone,
    },
  });

  // 2. Create dummy order
  const order = await prisma.order.create({
    data: {
      order_ref: `TEST-DEL-${timestamp}`,
      token_number: `TOK-${timestamp}`,
      customer_name: 'TEST DELETE CUSTOMER',
      whatsapp_number: testPhone,
      address: 'Test Address',
      product_name: 'Test Phone Model',
      total_amount: 50000,
      advance_amount: 5000,
      monthly_amount: 4500,
      months: 10,
      channel: 'test',
      customer_id: customer.id,
    },
  });

  // 3. Create dummy verification
  const verification = await prisma.verification.create({
    data: {
      order_id: order.id,
      verification_officer_id: 1,
      status: 'completed',
      start_time: new Date(),
    },
  });

  await prisma.purchaserVerification.create({
    data: {
      verification_id: verification.id,
      name: 'TEST DELETE CUSTOMER',
      father_husband_name: 'Test Father',
      present_address: 'Test Address',
      permanent_address: 'Test Address',
      cnic_number: testCnic,
      telephone_number: testPhone,
      employer_name: 'Test Employer',
      employer_address: 'Test Address',
      designation: 'Tester',
      nearest_location: 'Test Loc',
    },
  });

  console.log(`Created dummy Order #${order.id} (${order.order_ref}) for Customer #${customer.id}`);

  // Mock req & res for controller invocation
  const req = {
    params: { orderId: String(order.id) },
    user: { id: 1, role: 'Super Admin' },
  };

  let controllerResponse = null;
  const res = {
    status: (code) => ({
      json: (data) => {
        controllerResponse = { status: code, data };
        return controllerResponse;
      },
    }),
    json: (data) => {
      controllerResponse = { status: 200, data };
      return controllerResponse;
    },
  };

  console.log('--- CALLING deleteOrderPermanently CONTROLLER ---');
  await deleteOrderPermanently(req, res);
  console.log('Response:', controllerResponse);

  // Verify DB cleanup
  const remainingOrder = await prisma.order.findUnique({ where: { id: order.id } });
  const remainingVerification = await prisma.verification.findUnique({ where: { id: verification.id } });
  const remainingCustomer = await prisma.customer.findUnique({ where: { id: customer.id } });

  console.log('Verification Check:');
  console.log('  Order exists?:', Boolean(remainingOrder));
  console.log('  Verification exists?:', Boolean(remainingVerification));
  console.log('  Customer exists?:', Boolean(remainingCustomer));

  if (!remainingOrder && !remainingVerification && !remainingCustomer) {
    console.log('\n✅ TEST ORDER PERMANENT DELETION PASSED 100%!');
  } else {
    console.error('\n❌ DELETION TEST FAILED — SOME RECORDS REMAIN!');
  }

  process.exit(0);
}

testDeletion().catch(err => {
  console.error(err);
  process.exit(1);
});
