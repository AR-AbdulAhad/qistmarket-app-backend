// Read-only heuristic scan for leftover development/testing data mixed into
// live production data. Never deletes anything — prints a report (and writes
// a CSV) for manual review. A separate, explicitly-confirmed script should
// do any actual deletion, the same review-then-delete pattern already used
// this session for the SmartPay consumer-number data fixes.
//
// Run: node scratch/audit_test_data.js
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TEST_NAME_PATTERN = /\b(test|demo|sample|xxx+|asdf|qwerty|dummy|fake)\b/i;

// A CNIC/phone that is either an obviously-placeholder pattern (all-repeated
// digits, or a long run of the same digit) or one this scan has already seen
// reused across more than one account — real CNICs/phones are 1:1 with a
// single person and should never repeat across unrelated accounts.
function isRepeatedOrSequentialDigits(value) {
  const digits = (value || '').replace(/\D/g, '');
  if (digits.length < 6) return false;
  if (/^(\d)\1+$/.test(digits)) return true; // all same digit
  // 4+ identical digits in a row anywhere (e.g. "0000", "1111")
  if (/(\d)\1{3,}/.test(digits)) return true;
  return false;
}

async function findDuplicated(values) {
  const counts = {};
  for (const v of values) {
    if (!v) continue;
    counts[v] = (counts[v] || 0) + 1;
  }
  return new Set(Object.entries(counts).filter(([, c]) => c > 1).map(([v]) => v));
}

async function auditUsers() {
  const users = await prisma.user.findMany({
    select: { id: true, username: true, full_name: true, phone: true, cnic: true, status: true, created_at: true },
  });
  const dupPhones = await findDuplicated(users.map((u) => u.phone));
  const dupCnics = await findDuplicated(users.map((u) => u.cnic));

  const flagged = [];
  for (const u of users) {
    const reasons = [];
    if (TEST_NAME_PATTERN.test(u.username || '') || TEST_NAME_PATTERN.test(u.full_name || '')) reasons.push('name/username looks like a test account');
    if (isRepeatedOrSequentialDigits(u.cnic)) reasons.push('placeholder-looking CNIC');
    if (isRepeatedOrSequentialDigits(u.phone)) reasons.push('placeholder-looking phone');
    if (u.phone && dupPhones.has(u.phone)) reasons.push('phone reused by another account');
    if (u.cnic && dupCnics.has(u.cnic)) reasons.push('CNIC reused by another account');
    if (reasons.length) flagged.push({ type: 'User', id: u.id, label: `${u.username} (${u.full_name})`, reasons, created_at: u.created_at });
  }
  return flagged;
}

async function auditOrders() {
  const orders = await prisma.order.findMany({
    select: { id: true, order_ref: true, customer_name: true, whatsapp_number: true, channel: true, total_amount: true, created_at: true },
  });

  const flagged = [];
  for (const o of orders) {
    const reasons = [];
    if ((o.channel || '').toLowerCase() === 'test') reasons.push(`channel is literally "${o.channel}"`);
    if (TEST_NAME_PATTERN.test(o.customer_name || '')) reasons.push('customer name looks like a test entry');
    if (isRepeatedOrSequentialDigits(o.whatsapp_number)) reasons.push('placeholder-looking phone number');
    if (o.total_amount !== null && o.total_amount !== undefined && o.total_amount < 100) reasons.push(`trivial total_amount (${o.total_amount})`);
    if (reasons.length) flagged.push({ type: 'Order', id: o.id, label: `${o.order_ref} — ${o.customer_name}`, reasons, created_at: o.created_at });
  }
  return flagged;
}

async function auditCustomers() {
  const customers = await prisma.customer.findMany({ select: { id: true, name: true, cnic: true, mobile: true, created_at: true } });
  const dupCnics = await findDuplicated(customers.map((c) => c.cnic));

  const flagged = [];
  for (const c of customers) {
    const reasons = [];
    if (TEST_NAME_PATTERN.test(c.name || '')) reasons.push('name looks like a test entry');
    if (isRepeatedOrSequentialDigits(c.cnic)) reasons.push('placeholder-looking CNIC');
    if (isRepeatedOrSequentialDigits(c.mobile)) reasons.push('placeholder-looking phone');
    if (c.cnic && dupCnics.has(c.cnic)) reasons.push('CNIC reused by another customer record');
    if (reasons.length) flagged.push({ type: 'Customer', id: c.id, label: `${c.name} (${c.cnic || 'no CNIC'})`, reasons, created_at: c.created_at });
  }
  return flagged;
}

async function relatedRecordCounts(orderIds) {
  if (orderIds.length === 0) return {};
  const [payments, verifications, deliveries] = await Promise.all([
    prisma.orderPayment.groupBy({ by: ['order_id'], where: { order_id: { in: orderIds } }, _count: { _all: true } }),
    prisma.verification.count({ where: { order_id: { in: orderIds } } }),
    prisma.delivery.count({ where: { order_id: { in: orderIds } } }),
  ]);
  return {
    payments: payments.reduce((s, p) => s + p._count._all, 0),
    verifications,
    deliveries,
  };
}

async function main() {
  console.log('Scanning for leftover test/development data (read-only — nothing will be changed)...\n');

  const [userFlags, orderFlags, customerFlags] = await Promise.all([auditUsers(), auditOrders(), auditCustomers()]);
  const all = [...userFlags, ...orderFlags, ...customerFlags];

  const orderIds = orderFlags.map((f) => f.id);
  const impact = await relatedRecordCounts(orderIds);

  console.log(`Flagged ${userFlags.length} user(s), ${orderFlags.length} order(s), ${customerFlags.length} customer(s).\n`);
  if (orderFlags.length) {
    console.log(`Related-record impact for flagged orders: ${impact.payments || 0} payment(s), ${impact.verifications || 0} verification(s), ${impact.deliveries || 0} deliveries(s).\n`);
  }

  for (const group of [['USERS', userFlags], ['ORDERS', orderFlags], ['CUSTOMERS', customerFlags]]) {
    const [label, list] = group;
    if (!list.length) continue;
    console.log(`--- ${label} (${list.length}) ---`);
    for (const f of list) {
      console.log(`  [${f.type} #${f.id}] ${f.label} — ${f.reasons.join('; ')}`);
    }
    console.log('');
  }

  const csvLines = ['type,id,label,reasons,created_at'];
  for (const f of all) {
    const escape = (s) => `"${String(s).replace(/"/g, '""')}"`;
    csvLines.push([f.type, f.id, escape(f.label), escape(f.reasons.join('; ')), f.created_at?.toISOString?.() || ''].join(','));
  }
  const outPath = path.join(__dirname, `test_data_audit_${Date.now()}.csv`);
  fs.writeFileSync(outPath, csvLines.join('\n'));
  console.log(`Full report written to ${outPath}`);
  console.log('\nNothing was deleted. Review the list, then confirm which IDs to remove before any deletion runs.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
