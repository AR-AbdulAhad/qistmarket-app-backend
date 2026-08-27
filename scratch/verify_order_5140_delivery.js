const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Read-only: was a real physical device ever handed out for order 5140's
// delivery (id 769)? Checks the IMEI recorded on the Delivery, its current
// inventory status/outlet, and the StockTransfer row created at completion
// time — this tells us whether a unit actually left branch stock or not.
async function main() {
  const delivery = await prisma.delivery.findUnique({ where: { order_id: 5140 } });
  console.log('DELIVERY product_imei/selected_plan:', {
    id: delivery.id,
    product_imei: delivery.product_imei,
    selected_plan: delivery.selected_plan,
    feedback: delivery.feedback,
  });

  if (delivery.product_imei) {
    const inv = await prisma.outletInventory.findMany({
      where: { imei_serial: delivery.product_imei },
    });
    console.log('INVENTORY rows for this IMEI:', inv);
  }

  const transfers = await prisma.stockTransfer.findMany({
    where: { to_type: 'Customer', to_id: 5140 },
    include: { inventory: true },
  });
  console.log('STOCK TRANSFERS to this order:', JSON.stringify(transfers, null, 2));

  const cash = await prisma.cashInHand.findMany({ where: { order_id: 5140 } });
  console.log('CASH IN HAND rows for this order:', cash);
}

main().catch(console.error).finally(() => prisma.$disconnect());
