const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const inv = await prisma.outletInventory.findUnique({ where: { id: 1302 } });
  console.log('C71 INVENTORY (id 1302):', inv);

  const order = await prisma.order.findUnique({
    where: { id: 5140 },
    select: { total_amount: true, advance_amount: true, monthly_amount: true, months: true, product_name: true },
  });
  console.log('ORDER 5140 booked plan:', order);
}

main().catch(console.error).finally(() => prisma.$disconnect());
