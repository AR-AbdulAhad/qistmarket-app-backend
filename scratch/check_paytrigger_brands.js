const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// PayTrigger is only supposed to be used for tecno/infinix/itel (see
// src/config/paytrigger.js BRAND_PATTERNS). This is a read-only audit:
// for every PayTriggerDevice ever created, check its product_model (and the
// linked order's product_name, in case the snapshot drifted) against those
// patterns and report anything that isn't one of the 3 supported brands.
const BRAND_PATTERNS = {
  tecno: /tecno/i,
  infinix: /infinix/i,
  itel: /itel/i,
};

function detectBrand(name) {
  if (!name) return null;
  for (const [brand, pattern] of Object.entries(BRAND_PATTERNS)) {
    if (pattern.test(name)) return brand;
  }
  return null;
}

async function main() {
  const devices = await prisma.payTriggerDevice.findMany({
    select: {
      id: true,
      imei: true,
      order_ref: true,
      product_model: true,
      enrollment_status: true,
      created_at: true,
      order: { select: { product_name: true } },
    },
    orderBy: { created_at: 'desc' },
  });

  console.log(`Total PayTriggerDevice rows: ${devices.length}\n`);

  const counts = { tecno: 0, infinix: 0, itel: 0, unknown: 0 };
  const offenders = [];

  for (const d of devices) {
    const brand = detectBrand(d.product_model) || detectBrand(d.order?.product_name);
    if (brand) {
      counts[brand]++;
    } else {
      counts.unknown++;
      offenders.push(d);
    }
  }

  console.log('By brand:', counts);

  if (offenders.length > 0) {
    console.log(`\nFound ${offenders.length} device(s) enrolled in PayTrigger that are NOT tecno/infinix/itel:\n`);
    for (const o of offenders) {
      console.log(
        `- order_ref=${o.order_ref} imei=${o.imei} product_model="${o.product_model}" ` +
        `order.product_name="${o.order?.product_name}" status=${o.enrollment_status} created_at=${o.created_at.toISOString()}`
      );
    }
  } else {
    console.log('\nNo off-brand devices found — every PayTriggerDevice matches tecno/infinix/itel.');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
