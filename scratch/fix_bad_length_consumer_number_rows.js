const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Companion to fix_smartpay_consumer_numbers.js — that script only cleared
// the bad (non-8-digit) value off User.smart_pay_consumer_number, which lets
// the officer cash-submission flow self-heal (it generates a fresh number
// whenever the field is null). But two other flows read a "6500"-prefixed
// number straight off the ConsumerNumber table by id/ledger_id and reuse it
// as-is, with no length check and no self-healing:
//   - smartPayController.generateSmartPayQr (customer installment QR)
//   - ledgerController.fetchLedger (customer ledger/bill page)
// Any row here with a wrong-length consumer_number will keep sending SmartPay
// an invalid Consumer_Number forever unless the row itself is corrected.
//
// This regenerates a proper 8-digit ("6500" + 4 digits) value IN PLACE for
// every bad row (never deletes — preserves cash_submission_ref/history/FKs),
// using the same source-digit rule as generateSmartPayConsumerNumber
// (imei_serial's last 4 digits, else mobile_number's last 4), with the same
// conflict-digit-append uniqueness handling. Only rows confirmed NOT
// currently busy (bill_status 'U' with a still-future due_date) are touched
// — verified separately before running this with --fix.
//
// Run without --fix to only report; with --fix to actually update.

const SMARTPAY_PREFIX = '6500';

// NOTE: an earlier version of this function mirrored consumerNumberUtils.js's
// append-a-conflict-digit collision strategy — which breaks the required
// 8-digit total the moment two rows share a last-4-digit suffix (common here,
// since many rows come from patterned/sequential test mobile numbers). That
// left 12 rows still wrong-length after the first --fix pass. Fixed by
// incrementing the 4-digit suffix (wrapping mod 10000) until a free one is
// found instead — this always stays exactly "6500" + 4 digits.
async function generateValidSmartPayNumber(imei, mobile) {
  const source = (imei || mobile || '').replace(/\D/g, '') || String(Date.now());
  const seed = parseInt(source.slice(-4).padStart(4, '0'), 10);

  for (let i = 0; i < 10000; i += 1) {
    const candidateSuffix = String((seed + i) % 10000).padStart(4, '0');
    const candidate = SMARTPAY_PREFIX + candidateSuffix;
    const existing = await prisma.consumerNumber.findUnique({
      where: { consumer_number: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }

  throw new Error(`No free 8-digit SmartPay number found for seed ${seed}`);
}

async function main() {
  const shouldFix = process.argv.includes('--fix');
  const now = new Date();

  const rows = await prisma.consumerNumber.findMany({
    where: { consumer_number: { startsWith: SMARTPAY_PREFIX } },
  });
  const bad = rows.filter((r) => r.consumer_number.length !== 8);

  console.log(`Found ${rows.length} "${SMARTPAY_PREFIX}"-prefixed ConsumerNumber row(s), ${bad.length} with a wrong-length value:\n`);

  for (const r of bad) {
    const busy = r.bill_status === 'U' && r.due_date && new Date(r.due_date) >= now;
    console.log(`- id=${r.id} type=${r.type} old=${r.consumer_number} (len=${r.consumer_number.length}) ledger_id=${r.ledger_id} user_id=${r.user_id} busy=${busy}`);
  }

  if (!shouldFix) {
    console.log('\nRun again with --fix to regenerate correct 8-digit values in place.');
    return;
  }

  let fixed = 0;
  let skippedBusy = 0;
  for (const r of bad) {
    const busy = r.bill_status === 'U' && r.due_date && new Date(r.due_date) >= now;
    if (busy) {
      console.log(`SKIP (currently busy/reserved): id=${r.id} ${r.consumer_number}`);
      skippedBusy += 1;
      continue;
    }
    const newNumber = await generateValidSmartPayNumber(r.imei_serial, r.mobile_number);
    await prisma.consumerNumber.update({
      where: { id: r.id },
      data: { consumer_number: newNumber, updated_at: now },
    });
    console.log(`FIXED: id=${r.id} ${r.consumer_number} -> ${newNumber}`);
    fixed += 1;
  }

  console.log(`\nDone. Fixed ${fixed} row(s), skipped ${skippedBusy} currently-busy row(s).`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
