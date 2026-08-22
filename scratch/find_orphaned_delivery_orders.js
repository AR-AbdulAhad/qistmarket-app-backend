const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Read-only diagnostic: finds orders whose status is 'approved' or 'picked'
// (i.e. they show up in the Approved Order List) but which already have a
// Delivery record. That combination means the order was previously
// assigned/delivered and then someone hit "unassign" on it, silently
// reverting order.status back to 'approved' without touching the Delivery
// row — leaving Self Pickup / Delivery blocked with "already picked up"
// even though the order looks untouched in the list.
async function main() {
  const orders = await prisma.order.findMany({
    where: {
      status: { in: ['approved', 'picked'] },
      delivery: { isNot: null },
    },
    select: {
      id: true,
      order_ref: true,
      status: true,
      customer_name: true,
      outlet_id: true,
      updated_at: true,
      delivery: {
        select: {
          id: true,
          status: true,
          self_pickup: true,
          start_time: true,
          end_time: true,
          verified: true,
          updated_at: true,
        },
      },
    },
    orderBy: { updated_at: 'desc' },
  });

  console.log(`Found ${orders.length} order(s) with status in ['approved','picked'] that already have a Delivery record:\n`);
  for (const o of orders) {
    console.log(
      `Order #${o.order_ref} (id=${o.id}) — order.status="${o.status}" | ` +
      `delivery.status="${o.delivery.status}" self_pickup=${o.delivery.self_pickup} verified=${o.delivery.verified} | ` +
      `delivery ended=${o.delivery.end_time ?? 'n/a'} | order updated_at=${o.updated_at.toISOString()}`
    );
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
