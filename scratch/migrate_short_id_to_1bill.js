// One-time migration: point every existing ledger's short_id at the
// customer's real 1Bill consumer number, while preserving the OLD short_id
// as a resolvable redirect (a ConsumerNumber row of type 'legacy_short_id')
// so any link already sent to a real customer keeps working via
// ledgerController.js's fetchLedgerByShortToken fallback.
//
// Usage: node scratch/migrate_short_id_to_1bill.js         (dry run, no writes)
//        node scratch/migrate_short_id_to_1bill.js --apply (writes changes)
const prisma = require('../lib/prisma');
const { generateConsumerNumber } = require('../src/utils/consumerNumberUtils');

const APPLY = process.argv.includes('--apply');
const now = () => new Date();

(async () => {
  const ledgers = await prisma.installmentLedger.findMany({
    include: {
      consumer_numbers: true,
      order: { select: { customer_name: true, whatsapp_number: true, imei_serial: true } },
      delivery: { select: { id: true, product_imei: true } },
    },
  });

  console.log(`Found ${ledgers.length} ledger(s). Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  let alreadyCorrect = 0;
  let toMigrate = 0;
  let generated = 0;
  let skippedNoOrder = 0;
  let skippedTooLong = 0;
  const usedThisRun = new Set(); // guards against dry-run/same-batch duplicate generation

  for (const ledger of ledgers) {
    let oneBillNumber = ledger.consumer_numbers.find(c => c.consumer_number.startsWith('1017100015'))?.consumer_number || null;

    if (ledger.short_id === oneBillNumber && oneBillNumber) {
      alreadyCorrect += 1;
      continue;
    }

    if (!oneBillNumber) {
      // Genuinely missing (older ledger predating dual consumer-number
      // creation) — generate one now, same fallback the live ledger page
      // already uses for a missing SmartPay number.
      const mobile = ledger.order?.whatsapp_number || null;
      const imei = ledger.delivery?.product_imei || ledger.order?.imei_serial || null;
      if (!ledger.order) {
        skippedNoOrder += 1;
        console.log(`  SKIP ledger ${ledger.id}: no linked order.`);
        continue;
      }
      // generateConsumerNumber's own dedupe only sees rows already committed
      // to the DB. In APPLY mode that's fine (each row is written right
      // below before the next ledger is processed), but in DRY RUN nothing
      // is ever committed, so two ledgers sharing the same imei/mobile
      // source deterministically get the identical candidate every time —
      // bound the retry so that doesn't spin forever, and just note it.
      let attempts = 0;
      do {
        oneBillNumber = await generateConsumerNumber(imei, mobile);
        attempts += 1;
      } while (usedThisRun.has(oneBillNumber) && attempts < 20);
      if (usedThisRun.has(oneBillNumber)) {
        console.log(`    (note: ${oneBillNumber} collides with an earlier entry in this DRY RUN only — APPLY mode commits each row immediately so this resolves for real)`);
      }
      usedThisRun.add(oneBillNumber);
      generated += 1;
      console.log(`  ledger ${ledger.id}: no 1Bill number existed, would generate ${oneBillNumber} (len ${oneBillNumber.length})`);
      if (APPLY) {
        await prisma.consumerNumber.create({
          data: {
            consumer_number: oneBillNumber,
            ledger_id: ledger.id,
            delivery_id: ledger.delivery?.id || null,
            customer_name: ledger.order.customer_name || 'N/A',
            mobile_number: mobile || 'N/A',
            imei_serial: imei,
            amount_due: 0,
            billing_month: String(now().getFullYear()).slice(-2) + String(now().getMonth() + 1).padStart(2, '0'),
            due_date: now(),
            bill_status: 'U',
            created_at: now(),
            updated_at: now(),
          },
        });
      }
    }

    // installment_ledgers.short_id is VARCHAR(20) — a handful of older rows
    // hit generateConsumerNumber's collision-resolution (which appends a
    // digit and retries) enough times in clustered demo/seed data that the
    // resulting number outgrew that limit. Assigning it would truncate or
    // fail outright, so leave short_id as it was rather than risk either.
    if (oneBillNumber.length > 20) {
      skippedTooLong += 1;
      console.log(`  SKIP ledger ${ledger.id} (order ${ledger.order_id}): 1Bill number ${oneBillNumber} is ${oneBillNumber.length} chars, exceeds short_id's 20-char column limit. short_id left as ${ledger.short_id || '(null)'}.`);
      continue;
    }

    toMigrate += 1;
    const oldShortId = ledger.short_id;
    console.log(`  ledger ${ledger.id} (order ${ledger.order_id}): short_id ${oldShortId || '(null)'} -> ${oneBillNumber} (len ${oneBillNumber.length})`);

    if (APPLY) {
      // NOTE: an earlier version of this script preserved the old short_id
      // as a resolvable 'legacy_short_id' redirect row, so a link already
      // sent to a customer would keep working after migration. Confirmed
      // with the client afterwards: that's not wanted — only the 1Bill ID
      // should ever open a ledger, so the old short_id is simply dropped
      // (not written anywhere) and stops resolving.
      await prisma.installmentLedger.update({
        where: { id: ledger.id },
        data: { short_id: oneBillNumber, updated_at: now() },
      });
    }
  }

  console.log('---');
  console.log('Already correct:', alreadyCorrect);
  console.log('Migrated:', toMigrate, '(of which newly generated a 1Bill number:', generated, ')');
  console.log('Skipped (no order):', skippedNoOrder);
  console.log('Skipped (1Bill number too long for short_id):', skippedTooLong);
  if (!APPLY) console.log('\nDry run only — re-run with --apply to write changes.');

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
