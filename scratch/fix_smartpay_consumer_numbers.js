const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// SmartPay rejects any Consumer_Number that isn't 8 digits total ("6500" + 4
// digits) with {"statusCode":"401","statusMessage":"Failed: 01-Invalid bill
// data)"}. A previous version of generateSmartPayConsumerNumber produced
// 10-digit numbers ("6500" + 6 digits), which got saved onto User rows and
// are reused forever (submitBankDeposit only generates a new one when the
// column is null) — so anyone who already tried the QR/1bill outlet deposit
// flow is stuck rejected even after the generator itself is fixed.
//
// This clears the bad (non-8-digit) smart_pay_consumer_number values so
// they're regenerated correctly (in the new 8-digit format) on next use.
// Run with --fix to actually clear them; without it, only reports.
async function main() {
  const shouldFix = process.argv.includes('--fix');

  const users = await prisma.user.findMany({
    where: { smart_pay_consumer_number: { startsWith: '6500' } },
    select: { id: true, username: true, full_name: true, smart_pay_consumer_number: true },
  });

  const bad = users.filter(u => (u.smart_pay_consumer_number || '').length !== 8);

  console.log(`Found ${users.length} user(s) with a SmartPay consumer number, ${bad.length} in the bad (non-8-digit) format:\n`);
  for (const u of bad) {
    console.log(`- user_id=${u.id} username=${u.username} full_name=${u.full_name} smart_pay_consumer_number=${u.smart_pay_consumer_number} (len=${u.smart_pay_consumer_number.length})`);
  }

  if (shouldFix && bad.length > 0) {
    for (const u of bad) {
      await prisma.user.update({
        where: { id: u.id },
        data: { smart_pay_consumer_number: null },
      });
    }
    console.log(`\nCleared smart_pay_consumer_number on ${bad.length} user(s) — a fresh 8-digit number will be generated on their next QR/1bill deposit attempt.`);
  } else if (bad.length > 0) {
    console.log('\nRun again with --fix to clear these so they regenerate correctly.');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
