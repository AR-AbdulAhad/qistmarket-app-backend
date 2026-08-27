const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Read-only inspection for order 5140 (QIST-20260727-8226) — stuck showing
// "Delivery Completed / already picked up" on the self-pickup screen while
// the Approved Order List still shows it as Approved. Prints everything
// attached to its Delivery record (if any) so we can decide what's safe to
// clean up. Does NOT modify anything.
async function main() {
  const order = await prisma.order.findUnique({
    where: { id: 5140 },
    select: {
      id: true,
      order_ref: true,
      status: true,
      is_delivered: true,
      outlet_id: true,
      delivery_officer_id: true,
      updated_at: true,
    },
  });

  if (!order) {
    console.log('Order 5140 not found in this database.');
    return;
  }

  console.log('ORDER:', order);

  const delivery = await prisma.delivery.findUnique({
    where: { order_id: 5140 },
    include: {
      uploads: true,
      installment_ledger: true,
      consumerNumbers: true,
      paytrigger_devices: true,
    },
  });

  if (!delivery) {
    console.log('No Delivery record found for order 5140.');
    return;
  }

  console.log('DELIVERY:', {
    id: delivery.id,
    status: delivery.status,
    self_pickup: delivery.self_pickup,
    verified: delivery.verified,
    start_time: delivery.start_time,
    end_time: delivery.end_time,
    created_at: delivery.created_at,
    updated_at: delivery.updated_at,
  });
  console.log('UPLOADS:', delivery.uploads.length, delivery.uploads);
  console.log('INSTALLMENT_LEDGER:', delivery.installment_ledger);
  console.log('CONSUMER_NUMBERS:', delivery.consumerNumbers.length, delivery.consumerNumbers);
  console.log('PAYTRIGGER_DEVICES:', delivery.paytrigger_devices.length, delivery.paytrigger_devices);
}

main().catch(console.error).finally(() => prisma.$disconnect());
