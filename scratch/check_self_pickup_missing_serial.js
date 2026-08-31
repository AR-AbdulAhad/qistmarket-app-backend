const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// getSelfPickupInventory (ordersController.js) requires imei_serial to be
// non-null AND non-empty for an item to show up in the self-pickup stock
// search — so any "In Stock" item without a serial recorded is invisible
// there even though it shows fine in the regular Stock List. Laptops in
// particular are more likely to have been added without one. This is a
// read-only check of how many/which items are affected.
async function main() {
  const missing = await prisma.outletInventory.findMany({
    where: {
      status: 'In Stock',
      OR: [
        { imei_serial: null },
        { imei_serial: '' },
      ],
    },
    select: {
      id: true,
      outlet_id: true,
      product_name: true,
      category: true,
      color_variant: true,
      quantity: true,
      imei_serial: true,
    },
    orderBy: { product_name: 'asc' },
  });

  console.log(`Found ${missing.length} "In Stock" item(s) with no imei_serial — invisible to self-pickup search:\n`);
  for (const m of missing) {
    console.log(`- id=${m.id} outlet_id=${m.outlet_id} "${m.product_name}" category=${m.category} color=${m.color_variant} qty=${m.quantity} imei_serial=${JSON.stringify(m.imei_serial)}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
