/**
 * One-time backfill: syncBlacklistStatus() only started logging a
 * BlacklistAction row for auto-flagged (90+ day) accounts going forward.
 * Anyone already flagged before that change has is_blacklisted = true but
 * no BlacklistAction row, so the Blacklisted Customers list shows a blank
 * "Blacklist Date" / "Reason" / "Blacklisted By" for them.
 *
 * This reconstructs an approximate blacklist date for those existing
 * records — the day their overdue crossed the 90-day threshold (or,
 * for zero-payment accounts, delivery date + 90 days) — and inserts one
 * "auto" BlacklistAction per CNIC that's missing one.
 *
 * Safe to re-run: it only inserts for CNICs that still have no
 * 'blacklist' BlacklistAction row.
 *
 * Usage: node scripts/backfillAutoBlacklistActions.js
 */
const prisma = require('../lib/prisma');

function reconstructBlacklistDate(order, rows) {
  const installments = rows.filter((r) => r.month > 0);
  const paidCount = installments.filter((r) => r.status === 'paid' || r.status === 'Paid').length;
  const deliveryDate = new Date(order.delivery?.end_time || order.updated_at);

  if (paidCount === 0 && !isNaN(deliveryDate.getTime())) {
    const d = new Date(deliveryDate);
    d.setDate(d.getDate() + 90);
    return d;
  }

  let earliestCrossing = null;
  for (const r of installments) {
    if (r.status === 'paid' || r.status === 'Paid') continue;
    const dDate = r.due_date || r.dueDate;
    if (!dDate) continue;
    const dueDate = new Date(dDate);
    if (isNaN(dueDate.getTime())) continue;
    const crossing = new Date(dueDate);
    crossing.setDate(crossing.getDate() + 90);
    if (!earliestCrossing || crossing < earliestCrossing) earliestCrossing = crossing;
  }
  return earliestCrossing;
}

async function main() {
  const orders = await prisma.order.findMany({
    where: { is_delivered: true },
    include: {
      verification: { include: { purchaser: true, grantors: true } },
      delivery: { include: { installment_ledger: true } },
    },
  });

  const existingActionCnics = new Set(
    (await prisma.blacklistAction.findMany({ where: { action: 'blacklist' }, select: { cnic: true } }))
      .map((a) => a.cnic)
  );

  const toCreate = new Map(); // cnic -> Date

  for (const order of orders) {
    const ledgerModel = order.delivery?.installment_ledger;
    if (!ledgerModel?.ledger_rows) continue;
    let rows;
    try {
      rows = Array.isArray(ledgerModel.ledger_rows) ? ledgerModel.ledger_rows : JSON.parse(ledgerModel.ledger_rows);
    } catch (e) { continue; }
    if (!Array.isArray(rows)) continue;

    const purchaser = order.verification?.purchaser;
    const grantors = order.verification?.grantors || [];
    const blacklistedPeople = [
      ...(purchaser?.is_blacklisted && purchaser.cnic_number ? [purchaser.cnic_number] : []),
      ...grantors.filter((g) => g.is_blacklisted && g.cnic_number).map((g) => g.cnic_number),
    ];
    if (blacklistedPeople.length === 0) continue;

    const missing = blacklistedPeople.filter((cnic) => !existingActionCnics.has(cnic) && !toCreate.has(cnic));
    if (missing.length === 0) continue;

    const now = new Date();
    let reconstructed = reconstructBlacklistDate(order, rows) || now;
    if (reconstructed > now) reconstructed = now; // clamp — ledger test data can carry future-dated rows
    for (const cnic of missing) toCreate.set(cnic, reconstructed);
  }

  if (toCreate.size === 0) {
    console.log('Nothing to backfill — every currently-blacklisted CNIC already has a BlacklistAction row.');
    return;
  }

  await prisma.blacklistAction.createMany({
    data: Array.from(toCreate.entries()).map(([cnic, date]) => ({
      cnic,
      action: 'blacklist',
      category: 'auto',
      reason: 'Auto-flagged (90+ days delinquency)',
      status: 'approved',
      created_at: date,
      approved_at: date,
    })),
  });

  console.log(`Backfilled ${toCreate.size} BlacklistAction row(s):`);
  for (const [cnic, date] of toCreate.entries()) {
    console.log(`  ${cnic} -> ${date.toISOString().slice(0, 10)}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
