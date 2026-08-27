const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Read-only: order 5237 (QIST-20260730-7545) shares the same product_imei
// (862149080139258) as order 5140's delivery — need its full picture before
// deciding how to untangle the two.
async function main() {
  const order = await prisma.order.findUnique({
    where: { id: 5237 },
    select: {
      id: true, order_ref: true, status: true, is_delivered: true,
      customer_name: true, whatsapp_number: true, product_name: true,
      imei_serial: true, outlet_id: true, updated_at: true,
    },
  });
  console.log('ORDER 5237:', order);

  const delivery = await prisma.delivery.findUnique({
    where: { order_id: 5237 },
    include: { uploads: true, installment_ledger: true, consumerNumbers: true, paytrigger_devices: true },
  });
  console.log('DELIVERY:', delivery && {
    id: delivery.id, status: delivery.status, self_pickup: delivery.self_pickup,
    product_imei: delivery.product_imei, selected_plan: delivery.selected_plan,
    created_at: delivery.created_at,
  });
  console.log('UPLOADS:', delivery?.uploads);
  console.log('INSTALLMENT_LEDGER:', delivery?.installment_ledger);
  console.log('CONSUMER_NUMBERS:', delivery?.consumerNumbers);

  const cash = await prisma.cashInHand.findMany({ where: { order_id: 5237 } });
  console.log('CASH IN HAND:', cash);

  const transfers = await prisma.stockTransfer.findMany({
    where: { to_type: 'Customer', to_id: 5237 },
    include: { inventory: true },
  });
  console.log('STOCK TRANSFERS:', transfers.map(t => ({ id: t.id, inventory_id: t.inventory_id, imei: t.inventory?.imei_serial, product: t.inventory?.product_name, created_at: t.created_at })));
}

main().catch(console.error).finally(() => prisma.$disconnect());
