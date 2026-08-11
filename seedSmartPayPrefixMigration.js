/**
 * seedSmartPayPrefixMigration.js
 *
 * Ek dafa chalao — yeh script existing SmartPay consumer numbers ka
 * purana testing prefix "6002" dhoondh kar naya production prefix
 * "6500" me convert karti hai (suffix wahi rehta hai, sirf prefix badalta hai).
 *
 * Update hoti hain:
 *   - consumer_numbers.consumer_number
 *   - users.smart_pay_consumer_number
 *
 * Note: smartpay_payment_logs (historical transaction logs) jaan boojh kar
 * chhoo nahi ki jaati — woh audit trail hai, badalna history ko galat kar dega.
 */

process.env.TZ = 'Asia/Karachi';
require('dotenv').config();

const prisma = require('./lib/prisma');

const OLD_PREFIX = '6002';
const NEW_PREFIX = '6500';

async function migrateSmartPayPrefix() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  SmartPay Prefix Migration: "${OLD_PREFIX}" → "${NEW_PREFIX}"`);
  console.log('═══════════════════════════════════════════════════════');

  const oldRows = await prisma.consumerNumber.findMany({
    where: { consumer_number: { startsWith: OLD_PREFIX } },
    select: { id: true, consumer_number: true, user_id: true },
    orderBy: { id: 'asc' },
  });

  if (oldRows.length === 0) {
    console.log(`✅ No consumer_numbers rows found with prefix "${OLD_PREFIX}". Nothing to do.`);
  }

  // Existing NEW_PREFIX-wale numbers, taaki collision check ho sake.
  const newRowsExisting = await prisma.consumerNumber.findMany({
    where: { consumer_number: { startsWith: NEW_PREFIX } },
    select: { consumer_number: true },
  });
  const takenNewNumbers = new Set(newRowsExisting.map((r) => r.consumer_number));

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of oldRows) {
    const suffix = row.consumer_number.slice(OLD_PREFIX.length);
    const newNumber = NEW_PREFIX + suffix;

    if (takenNewNumbers.has(newNumber)) {
      console.warn(`  ⚠️  Skipping "${row.consumer_number}" → "${newNumber}" already exists (collision).`);
      skipped++;
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.consumerNumber.update({
          where: { id: row.id },
          data: { consumer_number: newNumber },
        });

        if (row.user_id) {
          await tx.user.updateMany({
            where: { id: row.user_id, smart_pay_consumer_number: row.consumer_number },
            data: { smart_pay_consumer_number: newNumber },
          });
        }
      });

      takenNewNumbers.add(newNumber);
      console.log(`  ✅ ${row.consumer_number} → ${newNumber}`);
      updated++;
    } catch (err) {
      console.error(`  ❌ ${row.consumer_number} — ERROR: ${err.message}`);
      errors++;
    }
  }

  // Orphan check: users jinka smart_pay_consumer_number ab bhi purane prefix
  // ke sath hai lekin consumer_numbers me koi linked row nahi thi.
  const orphanUsers = await prisma.user.findMany({
    where: { smart_pay_consumer_number: { startsWith: OLD_PREFIX } },
    select: { id: true, smart_pay_consumer_number: true },
  });

  for (const user of orphanUsers) {
    const suffix = user.smart_pay_consumer_number.slice(OLD_PREFIX.length);
    const newNumber = NEW_PREFIX + suffix;

    if (takenNewNumbers.has(newNumber)) {
      console.warn(`  ⚠️  Skipping orphan user #${user.id} "${user.smart_pay_consumer_number}" → "${newNumber}" already exists (collision).`);
      skipped++;
      continue;
    }

    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { smart_pay_consumer_number: newNumber },
      });
      takenNewNumbers.add(newNumber);
      console.log(`  ✅ (orphan user #${user.id}) ${user.smart_pay_consumer_number} → ${newNumber}`);
      updated++;
    } catch (err) {
      console.error(`  ❌ (orphan user #${user.id}) — ERROR: ${err.message}`);
      errors++;
    }
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  Done!  ✅ Updated: ${updated}  ⚠️  Skipped: ${skipped}  ❌ Errors: ${errors}`);
  console.log('═══════════════════════════════════════════════════════\n');

  await prisma.$disconnect();
}

migrateSmartPayPrefix().catch(async (err) => {
  console.error('Fatal error:', err);
  await prisma.$disconnect();
  process.exit(1);
});