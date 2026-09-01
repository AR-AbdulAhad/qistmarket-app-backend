const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.outletInventory.findMany({
    where: { product_name: { contains: 'THINKPAD T470' } },
    select: { id: true, product_name: true, imei_serial: true, status: true, outlet_id: true, quantity: true, is_used: true }
  });
  console.log(JSON.stringify(rows, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
