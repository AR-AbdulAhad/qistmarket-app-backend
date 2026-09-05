// End-to-end test: extracts the real COLUMNS/headers/sampleRows arrays out of
// the dashboard's legacy-import page.tsx (the actual demo sheet the download
// button produces), replicates the frontend's positional-parsing logic
// exactly, and feeds both demo rows through the real commitLegacyImport
// controller. Confirms the newly added Next of Kin columns survive the full
// round trip (frontend column order -> parsed row object -> DB). Cleans up.
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { commitLegacyImport } = require('../src/controllers/legacyImportController');

const PAGE_TSX = path.join(
  __dirname,
  '../../qistmarket-app-dashboard/src/app/(site)/admin/legacy-import/page.tsx'
);

function extractArray(src, startMarker) {
  const idx = src.indexOf(startMarker);
  if (idx === -1) throw new Error('marker not found: ' + startMarker);
  let i = src.indexOf('[', idx);
  let depth = 0;
  const start = i;
  for (; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return new Function(`return ${src.slice(start, i + 1)}`)();
}

function mockRes() {
  const res = { statusCode: 200 };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  return res;
}

// Mirrors excelValueToIso() closely enough for DD/MM/YYYY demo strings.
function excelValueToIso(v) {
  if (!v) return v;
  if (v instanceof Date) return v.toISOString();
  const m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])).toISOString();
  return v;
}

async function cleanup(order) {
  const ledgerId = order.delivery?.installment_ledger?.id;
  if (ledgerId) {
    await prisma.consumerNumber.deleteMany({ where: { ledger_id: ledgerId } });
    await prisma.installmentLedger.delete({ where: { id: ledgerId } });
  }
  if (order.delivery) await prisma.delivery.delete({ where: { id: order.delivery.id } });
  if (order.verification?.nextOfKin) {
    await prisma.nextOfKinVerification.delete({ where: { id: order.verification.nextOfKin.id } });
  }
  await prisma.grantorVerification.deleteMany({ where: { verification_id: order.verification.id } });
  await prisma.purchaserVerification.deleteMany({ where: { verification_id: order.verification.id } });
  await prisma.verification.delete({ where: { id: order.verification.id } });
  await prisma.orderStatusHistory.deleteMany({ where: { order_id: order.id } });
  await prisma.order.delete({ where: { id: order.id } });
  if (order.customer) await prisma.customer.delete({ where: { id: order.customer.id } });
}

async function main() {
  const src = fs.readFileSync(PAGE_TSX, 'utf8');
  const COLUMNS = extractArray(src, 'const COLUMNS');
  const sampleRows = extractArray(src, 'const sampleRows = [');
  console.log('Extracted COLUMNS length:', COLUMNS.length);
  console.log('Extracted sampleRows count:', sampleRows.length);

  // Give both demo rows fresh unique CNIC/phone/serial so repeat test runs
  // never collide with leftovers or the user's real data.
  const suf = Date.now().toString().slice(-8);
  const cnicIdx = COLUMNS.indexOf('purchaser_cnic');
  const phoneIdx = COLUMNS.indexOf('purchaser_phone');
  const serialIdx = COLUMNS.indexOf('serial');
  sampleRows[0][cnicIdx] = `9${suf}1`;
  sampleRows[0][phoneIdx] = `0300${suf}`;
  sampleRows[0][serialIdx] = `TESTA${suf}`;
  sampleRows[1][cnicIdx] = `9${suf}2`;
  sampleRows[1][phoneIdx] = `0311${suf}`;
  sampleRows[1][serialIdx] = `TESTB${suf}`;

  const parsedRows = sampleRows.map((r) => {
    const row = {};
    COLUMNS.forEach((col, i) => {
      let v = r[i];
      if (['order_date', 'pay1_date', 'pay2_date', 'pay3_date', 'pay4_date'].includes(col)) {
        v = excelValueToIso(v);
      }
      row[col] = v;
    });
    return row;
  });

  console.log('\nParsed row 1 next-of-kin fields:', {
    next_of_kin_name: parsedRows[0].next_of_kin_name,
    next_of_kin_cnic: parsedRows[0].next_of_kin_cnic,
    next_of_kin_relation: parsedRows[0].next_of_kin_relation,
    next_of_kin_phone: parsedRows[0].next_of_kin_phone,
  });
  console.log('Parsed row 2 next-of-kin fields (expect all blank):', {
    next_of_kin_name: parsedRows[1].next_of_kin_name,
    next_of_kin_cnic: parsedRows[1].next_of_kin_cnic,
  });
  console.log('Parsed row 1 pay1/pay1_date (sanity: must not be shifted):', parsedRows[0].pay1, parsedRows[0].pay1_date);

  const superAdmin = await prisma.user.findFirst({ where: { role: { name: 'Super Admin' } } });
  const res = mockRes();
  await commitLegacyImport({ body: { rows: parsedRows }, user: { id: superAdmin.id } }, res);
  console.log('\nImport results:', JSON.stringify(res.body.results.map((r) => ({ success: r.success, order_id: r.order_id, error: r.error })), null, 2));

  const orders = [];
  for (const r of res.body.results) {
    if (!r.success) continue;
    const order = await prisma.order.findUnique({
      where: { id: r.order_id },
      include: {
        customer: true,
        delivery: { include: { installment_ledger: true } },
        verification: { include: { nextOfKin: true } },
      },
    });
    orders.push(order);
  }

  console.log('\n--- Row 1 (with Next of Kin) ---');
  console.log('nextOfKin:', orders[0]?.verification.nextOfKin);
  const ledgerRows0 = orders[0]?.delivery.installment_ledger.ledger_rows;
  console.log('paid month 1 extras:', JSON.stringify(ledgerRows0.find((row) => row.month === 1)));

  console.log('\n--- Row 2 (no Next of Kin) ---');
  console.log('nextOfKin (expect null):', orders[1]?.verification.nextOfKin);

  for (const order of orders) await cleanup(order);
  console.log('\nCleaned up.');
}

main()
  .catch((e) => console.error('TEST ERROR', e))
  .finally(() => prisma.$disconnect());
