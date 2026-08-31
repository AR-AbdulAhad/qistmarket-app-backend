const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Read-only diagnostic: finds orders whose Delivery record says
// 'awaiting_paytrigger_enrollment' (device pre-enrolled, waiting on PayTrigger)
// but whose order.status does NOT say the same — a desync caused by a bug in
// initiateGatedDelivery's "device already ACTIVE at pre-enroll time" edge case:
// if the immediate-completion attempt for an already-active device failed for
// any reason, the Delivery row got reverted back to 'awaiting_paytrigger_enrollment'
// but order.status was never advanced past whatever it was before (usually
// 'approved'), and the exception aborted the whole initiateGatedDelivery call
// before that line could ever run. Fixed going forward in
// deliveryCompletionService.js, but any order that already got stuck this way
// needs a one-time repair.
//
// Run with --fix to actually repair (sets order.status to match
// delivery.status). Without --fix it only reports what it would do.
async function main() {
  const shouldFix = process.argv.includes('--fix');

  const orders = await prisma.order.findMany({
    where: {
      delivery: { status: 'awaiting_paytrigger_enrollment' },
      status: { not: 'awaiting_paytrigger_enrollment' },
    },
    select: {
      id: true,
      order_ref: true,
      status: true,
      customer_name: true,
      outlet_id: true,
      updated_at: true,
      delivery: {
        select: { id: true, status: true, self_pickup: true, product_imei: true, updated_at: true },
      },
    },
    orderBy: { updated_at: 'desc' },
  });

  console.log(`Found ${orders.length} desynced order(s) (delivery says awaiting PayTrigger enrollment, order.status doesn't):\n`);
  for (const o of orders) {
    console.log(
      `Order #${o.order_ref} (id=${o.id}, "${o.customer_name}") — order.status="${o.status}" | ` +
      `delivery.status="${o.delivery.status}" imei=${o.delivery.product_imei} self_pickup=${o.delivery.self_pickup} | ` +
      `order updated_at=${o.updated_at.toISOString()}`
    );

    if (shouldFix) {
      await prisma.order.update({
        where: { id: o.id },
        data: { status: 'awaiting_paytrigger_enrollment', updated_at: new Date() },
      });
      console.log(`  -> fixed: order.status set to 'awaiting_paytrigger_enrollment' (now shows in Waiting PayTrigger Approval; use Cancel Enrollment there to revert to Approved if it should be retried instead).`);
    }
  }

  if (!shouldFix && orders.length > 0) {
    console.log('\nRun again with --fix to repair these (sets order.status to match delivery.status).');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
