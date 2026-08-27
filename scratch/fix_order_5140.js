const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Order 5140 (QIST-20260727-8226) had a genuinely completed Self Pickup
// delivery (delivery id 769, 2026-07-28) — real installment ledger + consumer
// numbers already exist. The next day (2026-07-29) an "unassign" action (pre
// the delivery-guard fix) wrongly reverted Order.status/is_delivered back to
// approved/false without touching the Delivery record, leaving the self-pickup
// screen stuck on "already picked up" while the order list still shows
// Approved. This restores the Order fields to match the completed delivery —
// it does not touch Delivery/ledger/consumer numbers, which were never wrong.
async function main() {
  const order = await prisma.order.findUnique({ where: { id: 5140 } });
  const delivery = await prisma.delivery.findUnique({ where: { order_id: 5140 } });

  if (!order || !delivery) {
    console.log('Order or Delivery not found — aborting, nothing changed.');
    return;
  }

  if (order.status === 'delivered' && order.is_delivered === true) {
    console.log('Order already shows delivered/is_delivered=true — nothing to do.');
    return;
  }

  if (order.status !== 'approved' || order.is_delivered !== false || delivery.status !== 'completed') {
    console.log('State does not match the expected corruption pattern — aborting for safety.');
    console.log({ order, delivery });
    return;
  }

  const updated = await prisma.order.update({
    where: { id: 5140 },
    data: {
      status: 'delivered',
      is_delivered: true,
      delivered_at: order.delivered_at || delivery.end_time || delivery.created_at,
      updated_at: new Date(),
    },
  });

  await prisma.orderStatusHistory.create({
    data: {
      order_id: 5140,
      old_status: 'approved',
      new_status: 'delivered',
      user_id: null,
      role_name: 'system',
      remarks: 'Manual correction: unassign on 2026-07-29 wrongly reverted this order after Self Pickup (delivery id 769) was already completed on 2026-07-28. Restored status/is_delivered to match the completed delivery.',
      created_at: new Date(),
    },
  });

  console.log('Fixed. Updated order:', updated);
}

main().catch(console.error).finally(() => prisma.$disconnect());
