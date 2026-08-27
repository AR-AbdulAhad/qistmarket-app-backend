const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Read-only: trace both IMEIs across Order/OutletInventory/Delivery/PayTriggerDevice
// to figure out where each one actually belongs before touching any data.
//   C71 (correct, physically handed to M.Anees): 860695075268538
//   C100i (wrongly recorded against order 5140):  862149080139258
const IMEIS = ['860695075268538', '862149080139258'];

async function main() {
  for (const imei of IMEIS) {
    console.log(`\n=== IMEI ${imei} ===`);

    const orders = await prisma.order.findMany({
      where: { imei_serial: imei },
      select: { id: true, order_ref: true, status: true, is_delivered: true, customer_name: true, whatsapp_number: true, product_name: true },
    });
    console.log('Order.imei_serial matches:', orders);

    const inv = await prisma.outletInventory.findMany({ where: { imei_serial: imei } });
    console.log('OutletInventory rows:', inv.map(i => ({ id: i.id, outlet_id: i.outlet_id, product_name: i.product_name, status: i.status, updated_at: i.updated_at })));

    const deliveries = await prisma.delivery.findMany({
      where: { product_imei: imei },
      include: { order: { select: { id: true, order_ref: true, status: true, customer_name: true } } },
    });
    console.log('Delivery rows with this product_imei:', deliveries.map(d => ({ id: d.id, order_id: d.order_id, order_ref: d.order?.order_ref, order_status: d.order?.status, status: d.status, self_pickup: d.self_pickup, created_at: d.created_at })));

    const devices = await prisma.payTriggerDevice.findMany({ where: { imei } });
    console.log('PayTriggerDevice rows:', devices.map(d => ({ id: d.id, order_id: d.order_id, order_ref: d.order_ref, delivery_id: d.delivery_id, enrollment_status: d.enrollment_status, lock_status: d.lock_status, product_model: d.product_model, created_at: d.created_at })));
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
