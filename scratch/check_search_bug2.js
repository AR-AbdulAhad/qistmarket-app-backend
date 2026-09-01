const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const count = await prisma.outletInventory.count();
  console.log('total rows:', count);
  const sample = await prisma.outletInventory.findMany({ take: 5, select: { id: true, product_name: true } });
  console.log(sample);
}
main().catch(console.error).finally(() => prisma.$disconnect());
