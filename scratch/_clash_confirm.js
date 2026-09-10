const prisma = require('../lib/prisma');
(async () => {
  const orders = await prisma.order.findMany({
    where: { is_delivered: true },
    select: { id: true, order_ref: true, installment_ledger: { select: { id: true, short_id: true } },
      delivery: { select: { id: true, product_imei: true } } },
  });
  const last6 = (imei) => { const s = String(imei || '').replace(/\D/g, ''); return s.length >= 6 ? s.slice(-6) : null; };

  const withImei = orders.filter(o => last6(o.delivery?.product_imei));
  console.log(`delivered orders with a >=6-digit IMEI: ${withImei.length}`);
  for (const o of withImei) {
    const sid = last6(o.delivery.product_imei);
    const owner = await prisma.installmentLedger.findUnique({ where: { short_id: sid }, select: { order_id: true } });
    const takenByOther = owner && owner.order_id !== o.id;
    console.log(`  ${o.order_ref} imei=${o.delivery.product_imei} last6=${sid} ledger=${o.installment_ledger ? 'YES(' + o.installment_ledger.short_id + ')' : 'MISSING'} short_id_taken_by_other_order=${takenByOther ? 'ORDER#' + owner.order_id : 'no'}`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
