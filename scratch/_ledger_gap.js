const prisma = require('../lib/prisma');
(async () => {
  const delivered = await prisma.order.findMany({
    where: { is_delivered: true },
    select: { id: true, order_ref: true, months: true, monthly_amount: true, advance_amount: true, total_amount: true, status: true,
      installment_ledger: { select: { id: true, short_id: true, delivery_id: true } },
      delivery: { select: { id: true, status: true, product_imei: true, selected_plan: true, self_pickup: true, end_time: true } } },
  });
  const missing = delivered.filter(o => !o.installment_ledger);
  console.log(`delivered orders: ${delivered.length}, missing ledger: ${missing.length}`);
  for (const o of missing.slice(0, 25)) {
    const plan = o.delivery?.selected_plan;
    console.log(`  ${o.order_ref} | months=${o.months} monthly=${o.monthly_amount} adv=${o.advance_amount} | delivery=${o.delivery ? `#${o.delivery.id} ${o.delivery.status} imei=${o.delivery.product_imei} self=${o.delivery.self_pickup}` : 'NONE'} | plan=${typeof plan === 'string' ? plan.slice(0,120) : JSON.stringify(plan)?.slice(0,120)}`);
  }

  // short_id collision risk: how many IMEIs share the same last-6?
  const ledgers = await prisma.installmentLedger.findMany({ select: { short_id: true, order_id: true } });
  const byShort = new Map();
  for (const l of ledgers) { if (!l.short_id) continue; byShort.set(l.short_id, (byShort.get(l.short_id) || 0) + 1); }
  const dupes = [...byShort.entries()].filter(([, n]) => n > 1);
  console.log(`\nledgers: ${ledgers.length}, duplicate short_ids: ${dupes.length}`, dupes.slice(0, 10));

  // Would any *currently-delivered* IMEI's last-6 collide with an existing ledger short_id?
  const withImei = delivered.filter(o => o.delivery?.product_imei);
  const clash = withImei.filter(o => {
    const s = String(o.delivery.product_imei).replace(/\D/g, '');
    const sid = s.length >= 6 ? s.slice(-6) : null;
    return sid && byShort.has(sid) && o.installment_ledger?.short_id !== sid;
  });
  console.log(`orders whose IMEI last-6 already belongs to a different ledger: ${clash.length}`,
    clash.slice(0,10).map(o => `${o.order_ref}:${String(o.delivery.product_imei).slice(-6)}`));

  console.log('\nLEDGER_TOKEN_SECRET set?', !!process.env.LEDGER_TOKEN_SECRET);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
