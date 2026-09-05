// Verifies two fixes in deliveryController.js:
// 1. submitCashToOutlet no longer blocks with "No cash collections found"
//    for an officer who has zero CashInHand entries AND zero orders
//    assigned to them directly, as long as *some* order exists at their
//    outlet (or, failing that, anywhere in the system).
// 2. cancelCashSubmission can now cancel a submission even when only the
//    OfficerTransaction side is left "pending" (CashSubmissionHistory
//    missing/already resolved) — the state-desync scenario matching the
//    officer's screenshot ("Failed to cancel submission" on a card that
//    getCashInHand's own list, sourced from OfficerTransaction, still
//    shows as pending).
// Cleans up everything it creates.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { submitCashToOutlet, cancelCashSubmission } = require('../src/controllers/deliveryController');

function mockRes() {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function main() {
  const suf = Date.now().toString().slice(-6);
  const role = await prisma.role.findFirst({ where: { name: { in: ['Delivery Officer', 'Recovery Officer'] } } });
  const outlet = await prisma.outlet.findFirst();
  if (!role || !outlet) throw new Error('Need at least one officer role and one outlet in the DB to test.');

  // A brand-new officer: no CashInHand rows, no orders assigned to them
  // directly, but their outlet does have orders (matches the "OLD SADDAR
  // OUTLET" scenario from the screenshot — a real outlet with real orders,
  // just none assigned to *this* particular officer yet).
  const officer = await prisma.user.create({
    data: {
      full_name: `TEST OFFICER ${suf}`,
      username: `test_officer_${suf}`,
      role_id: role.id,
      outlet_id: outlet.id,
      status: 'active',
    },
  });

  console.log('--- Test 1: Submit Cash with zero balance, zero own orders ---');
  const res1 = mockRes();
  await submitCashToOutlet(
    {
      body: { outlet_id: outlet.id, payment_method: 'Cash', submit_amount: '100' },
      user: { id: officer.id },
      app: { get: () => null },
    },
    res1
  );
  console.log('Result:', res1.statusCode, JSON.stringify(res1.body));
  if (res1.statusCode !== 200) {
    console.error('FAILED — expected 200, submission should have gone through via outlet-wide/system-wide anchor fallback.');
  } else {
    console.log('PASSED — submission went through instead of "No cash collections found".');
  }

  const submissionRef1 = res1.body?.submission_ref
    || (await prisma.cashSubmissionHistory.findFirst({
        where: { cash_in_hand: { officer_id: officer.id } },
        orderBy: { id: 'desc' },
      }))?.submission_ref;
  console.log('submission_ref created:', submissionRef1);

  const cashInHandRows = await prisma.cashInHand.findMany({ where: { officer_id: officer.id } });
  console.log('CashInHand rows created for officer (expect 1, amount 0, anchored to some order):', cashInHandRows.map(r => ({ id: r.id, amount: r.amount, order_id: r.order_id })));

  console.log('\n--- Test 2: Cancel a submission where only OfficerTransaction is pending (CashSubmissionHistory desynced) ---');
  // Simulate the desync directly: flip the just-created CashSubmissionHistory
  // row to something other than 'pending' (as if a race/partial-failure had
  // already resolved it), while leaving the OfficerTransaction row pending —
  // exactly the state that previously made cancelCashSubmission 404.
  await prisma.cashSubmissionHistory.updateMany({
    where: { submission_ref: submissionRef1 },
    data: { status: 'paid' }, // pretend it was already resolved some other way
  });
  const txBefore = await prisma.officerTransaction.findMany({ where: { submission_ref: submissionRef1 } });
  console.log('OfficerTransaction status before cancel (expect pending):', txBefore.map(t => t.status));

  const res2 = mockRes();
  await cancelCashSubmission({ params: { submission_ref: submissionRef1 }, user: { id: officer.id } }, res2);
  console.log('Cancel result:', res2.statusCode, JSON.stringify(res2.body));
  if (res2.statusCode !== 200 || !res2.body.success) {
    console.error('FAILED — expected cancel to succeed via the OfficerTransaction fallback.');
  } else {
    console.log('PASSED — cancel succeeded despite CashSubmissionHistory already being non-pending.');
  }

  const txAfter = await prisma.officerTransaction.findMany({ where: { submission_ref: submissionRef1 } });
  console.log('OfficerTransaction status after cancel (expect cancelled):', txAfter.map(t => t.status));

  console.log('\n--- Test 3: Cancel with nothing pending anywhere (expect clean 404, not a crash) ---');
  const res3 = mockRes();
  await cancelCashSubmission({ params: { submission_ref: 'SUB-NONEXISTENT-0000' }, user: { id: officer.id } }, res3);
  console.log('Result:', res3.statusCode, JSON.stringify(res3.body));

  // Cleanup
  await prisma.otpLog.deleteMany({ where: { user_id: officer.id } }).catch(() => {});
  await prisma.officerTransaction.deleteMany({ where: { officer_id: officer.id } });
  await prisma.cashSubmissionHistory.deleteMany({ where: { cash_in_hand: { officer_id: officer.id } } });
  await prisma.cashInHand.deleteMany({ where: { officer_id: officer.id } });
  await prisma.user.delete({ where: { id: officer.id } });
  console.log('\nCleaned up.');
}

main()
  .catch((e) => console.error('TEST ERROR', e))
  .finally(() => prisma.$disconnect());
