const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const delivery = await prisma.delivery.findUnique({ where: { order_id: 5237 } });
  console.log('SHAHZAIB DELIVERY (order 5237):', delivery && { id: delivery.id, product_imei: delivery.product_imei, status: delivery.status });

  const cash = await prisma.cashInHand.findMany({ where: { order_id: 5237 } });
  console.log('SHAHZAIB CASH IN HAND:', cash.map(c => ({ id: c.id, imei_serial: c.imei_serial, amount: c.amount, status: c.status })));

  const transfers = await prisma.stockTransfer.findMany({ where: { to_type: 'Customer', to_id: 5237 }, include: { inventory: true } });
  console.log('SHAHZAIB STOCK TRANSFERS:', transfers.map(t => ({ id: t.id, inventory_id: t.inventory_id, imei: t.inventory?.imei_serial })));

  const inv = await prisma.outletInventory.findUnique({ where: { id: 1299 } });
  console.log('C100i INVENTORY (1299) status:', inv?.status);
}

main().catch(console.error).finally(() => prisma.$disconnect());
