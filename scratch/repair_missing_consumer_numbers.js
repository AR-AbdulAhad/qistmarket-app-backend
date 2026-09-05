// One-off repair script — run against PRODUCTION once, after deploying the
// fix in deliveryController.js's submitCash "self-heal" block.
//
// Bug: that self-heal block generated bill_consumer_number /
// smart_pay_consumer_number and saved them onto the User row, but never
// created the matching ConsumerNumber table rows (unlike signup(), which
// always does both). Any officer whose account went through that self-heal
// path ended up with a number embedded in their SmartPay QR that has no
// ConsumerNumber row behind it — so when SmartPay's webhook calls back to
// confirm payment, our lookup finds nothing and returns 404 "Consumer not
// found", and the app shows "Payment not received yet" forever.
//
// This script finds every User in that broken state and creates the missing
// ConsumerNumber row(s). If the officer currently has a pending Online cash
// submission (OfficerTransaction: type=debit, status=pending,
// payment_method=Online), the new row is linked to it via cash_submission_ref
// so SmartPay's NEXT retry (Hangfire keeps retrying for a while — check the
// dashboard for how many attempts are left) can complete the payment
// automatically, without needing a manual "mark as paid".
//
// Usage:  node scratch/repair_missing_consumer_numbers.js           (dry run)
//         node scratch/repair_missing_consumer_numbers.js --apply   (writes)

const prisma = require('../lib/prisma');

const APPLY = process.argv.includes('--apply');

async function main() {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { bill_consumer_number: { not: null } },
        { smart_pay_consumer_number: { not: null } },
      ],
    },
    select: { id: true, full_name: true, phone: true, bill_consumer_number: true, smart_pay_consumer_number: true },
  });

  const allNumbers = users.flatMap(u => [u.bill_consumer_number, u.smart_pay_consumer_number]).filter(Boolean);
  const existingRows = await prisma.consumerNumber.findMany({
    where: { consumer_number: { in: allNumbers } },
    select: { consumer_number: true },
  });
  const existingSet = new Set(existingRows.map(r => r.consumer_number));

  const broken = users.filter(u =>
    (u.bill_consumer_number && !existingSet.has(u.bill_consumer_number)) ||
    (u.smart_pay_consumer_number && !existingSet.has(u.smart_pay_consumer_number))
  );

  if (broken.length === 0) {
    console.log('No broken accounts found — every consumer number already has a ConsumerNumber row.');
    return;
  }

  console.log(`Found ${broken.length} account(s) with a missing ConsumerNumber row:\n`);

  const dueDateFar = new Date();
  dueDateFar.setFullYear(dueDateFar.getFullYear() + 10);

  for (const u of broken) {
    const missing = [];
    if (u.bill_consumer_number && !existingSet.has(u.bill_consumer_number)) missing.push(['bill', u.bill_consumer_number]);
    if (u.smart_pay_consumer_number && !existingSet.has(u.smart_pay_consumer_number)) missing.push(['smart_pay', u.smart_pay_consumer_number]);

    // Is there an active Online submission waiting on this officer right now?
    const pendingTxn = await prisma.officerTransaction.findFirst({
      where: { officer_id: u.id, type: 'debit', status: 'pending', payment_method: 'Online', submission_ref: { not: null } },
      orderBy: { transaction_date: 'desc' },
    });

    console.log(`User #${u.id} (${u.full_name}, ${u.phone}) — missing: ${missing.map(m => m[0]).join(', ')}${pendingTxn ? `  [has pending Online submission: ${pendingTxn.submission_ref}]` : ''}`);

    if (!APPLY) continue;

    const rows = missing.map(([, number]) => ({
      consumer_number: number,
      user_id: u.id,
      type: 'officer_cash',
      customer_name: u.full_name,
      mobile_number: u.phone || '03000000000',
      amount_due: pendingTxn ? pendingTxn.amount : 0,
      billing_month: '2401',
      due_date: pendingTxn ? new Date(Date.now() + 24 * 60 * 60 * 1000) : dueDateFar,
      bill_status: pendingTxn ? 'U' : 'P',
      cash_submission_ref: pendingTxn ? pendingTxn.submission_ref : null,
    }));

    await prisma.consumerNumber.createMany({ data: rows });
    console.log(`  -> created ${rows.length} row(s)`);
  }

  if (!APPLY) {
    console.log('\nDry run only — re-run with --apply to write these rows.');
  } else {
    console.log('\nDone. Any pending Online submission listed above should resolve on SmartPay\'s next retry.');
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
