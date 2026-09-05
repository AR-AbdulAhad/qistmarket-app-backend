// Deep structural comparison between a normal (live-workflow) order and a
// legacy-imported order — read-only, prints a report, changes nothing.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const FULL_INCLUDE = {
  customer: true,
  created_by: { select: { full_name: true, username: true } },
  assigned_to: { select: { full_name: true, username: true } },
  delivery_officer: { select: { full_name: true, username: true } },
  recovery_officer: { select: { full_name: true, username: true } },
  outlet: true,
  verification: {
    include: {
      purchaser: true,
      grantors: true,
      nextOfKin: true,
      verification_locations: { include: { photos: true } },
      documents: true,
    },
  },
  delivery: {
    include: {
      installment_ledger: { include: { consumer_numbers: true } },
      uploads: true,
    },
  },
  statusHistories: true,
  payments: true,
  cash_in_hand: true,
  complaints: true,
};

async function dump(orderId) {
  return prisma.order.findUnique({ where: { id: orderId }, include: FULL_INCLUDE });
}

function line(label, a, b) {
  const sa = a === undefined || a === null || a === '' ? '(empty)' : String(a);
  const sb = b === undefined || b === null || b === '' ? '(empty)' : String(b);
  const same = sa === sb;
  console.log(`  ${same ? ' ' : '⚠'} ${label.padEnd(28)} normal=${sa.slice(0, 40).padEnd(42)} legacy=${sb.slice(0, 60)}`);
}

async function main() {
  const normalId = 954;
  const legacyId = 1065;
  const n = await dump(normalId);
  const l = await dump(legacyId);

  console.log(`\n=== ORDER-LEVEL ===`);
  for (const f of ['status', 'channel', 'outlet_id', 'is_delivered', 'delivered_at', 'assigned_to_user_id', 'verification_assigned_at', 'delivery_officer_id', 'delivery_assigned_at', 'recovery_officer_id', 'recovery_assigned_at']) {
    line(f, n[f], l[f]);
  }
  console.log('  created_by:', n.created_by?.full_name, '|', l.created_by?.full_name);
  console.log('  outlet:', n.outlet?.name || '(none)', '|', l.outlet?.name || '(none)');

  console.log(`\n=== STATUS HISTORY ===`);
  console.log('  normal count:', n.statusHistories.length, n.statusHistories.map(h => h.new_status));
  console.log('  legacy count:', l.statusHistories.length, l.statusHistories.map(h => h.new_status));

  console.log(`\n=== VERIFICATION ===`);
  for (const f of ['status', 'home_location_required', 'home_location_verified', 'location_vo_sent', 'location_do_sent']) {
    line(f, n.verification?.[f], l.verification?.[f]);
  }
  console.log('  nextOfKin present:', !!n.verification?.nextOfKin, '|', !!l.verification?.nextOfKin);
  console.log('  verification_locations count:', n.verification?.verification_locations.length, '|', l.verification?.verification_locations.length);
  console.log('  documents count:', n.verification?.documents.length, '|', l.verification?.documents.length);
  if (n.verification?.documents.length) console.log('  normal doc types:', n.verification.documents.map(d => d.document_type));
  if (l.verification?.documents.length) console.log('  legacy doc types:', l.verification.documents.map(d => d.document_type));

  console.log(`\n=== PURCHASER FIELDS ===`);
  const pFields = Object.keys(n.verification?.purchaser || {});
  for (const f of pFields) {
    if (['id', 'verification_id', 'edit_history'].includes(f)) continue;
    line(f, n.verification?.purchaser?.[f], l.verification?.purchaser?.[f]);
  }

  console.log(`\n=== GRANTOR 1 FIELDS ===`);
  const ng1 = n.verification?.grantors.find(g => g.grantor_number === 1);
  const lg1 = l.verification?.grantors.find(g => g.grantor_number === 1);
  const gFields = Object.keys(ng1 || lg1 || {});
  for (const f of gFields) {
    if (['id', 'verification_id', 'edit_history'].includes(f)) continue;
    line(f, ng1?.[f], lg1?.[f]);
  }

  console.log(`\n=== DELIVERY ===`);
  for (const f of ['status', 'verified', 'self_pickup']) {
    line(f, n.delivery?.[f], l.delivery?.[f]);
  }
  console.log('  uploads count:', n.delivery?.uploads.length, '|', l.delivery?.uploads.length);

  console.log(`\n=== INSTALLMENT LEDGER ===`);
  const nLedger = n.delivery?.installment_ledger;
  const lLedger = l.delivery?.installment_ledger;
  console.log('  ledger_rows count:', nLedger?.ledger_rows?.length, '|', lLedger?.ledger_rows?.length);
  console.log('  consumer_numbers:', nLedger?.consumer_numbers?.map(c => `${c.consumer_number}(${c.type})`), '|', lLedger?.consumer_numbers?.map(c => `${c.consumer_number}(${c.type})`));
  console.log('  sample normal ledger row (month 1):', JSON.stringify(nLedger?.ledger_rows?.find(r => r.month === 1)));
  console.log('  sample legacy ledger row (month 1):', JSON.stringify(lLedger?.ledger_rows?.find(r => r.month === 1)));

  console.log(`\n=== OTHER RELATIONS ===`);
  console.log('  OrderPayment rows: normal =', n.payments.length, ', legacy =', l.payments.length);
  console.log('  CashInHand rows: normal =', n.cash_in_hand.length, ', legacy =', l.cash_in_hand.length);
  console.log('  Complaints: normal =', n.complaints.length, ', legacy =', l.complaints.length);
}

main().catch(console.error).finally(() => prisma.$disconnect());
