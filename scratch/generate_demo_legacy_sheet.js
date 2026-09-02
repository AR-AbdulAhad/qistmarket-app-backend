// Generates a demo legacy-ledger .xlsx matching the exact 28-column layout
// the Legacy Data Import page expects, with two illustrative rows:
//  - Row 1: delivered, installments still ongoing (2 of 12 paid)
//  - Row 2: fully paid off (all 6 installments paid, remain = 0)
// Uses the dashboard's xlsx dependency since the backend doesn't have one.
const path = require('path');
const XLSX = require(path.join(__dirname, '../../qistmarket-app-dashboard/node_modules/xlsx'));

const headers = [
  'ACC NO', 'G.NO', 'S.NO', 'DATE', 'ORDER BY', 'INS DATE', '1BILL ID',
  'Name', 'CNIC', 'Contact No.', 'Address',
  'ITEM PRICE', 'ITEM MODEL', 'SERIAL', 'Tenure', 'ADVANCE', 'INSTALLMENT',
  "Granter's 1 Name", 'Cnic', 'Contact No.',
  "Granter's 2 Name", 'Cnic', 'Contact No.',
  'PAY 1', 'PAY 2', 'PAY 3', 'PAY 4', 'remain',
];

const rows = [
  // Delivered, ongoing — 2 of 12 installments paid (matches the real
  // ADNAN AHSAN example: 61500 price, 6300 advance, 4600/month, remain 46000).
  [
    1, 1, 1, '04/06/2026', 'WALKING CUSTOMER', 1, '1017100015525265',
    'ADNAN AHSAN', '42101-9297807-5', '03153188174', 'FB AREA',
    61500, 'ZTE V80 8/256', '862484082525265', 12, 6300, 4600,
    'MATHEW EMMANUAL', '42101-9237108-3', '03118959818',
    'NAVEED UL HASSAN', '42201-1866190-5', '03333387388',
    4600, 4600, '', '', 46000,
  ],
  // Fully paid off — 6 of 6 installments paid, remain = 0.
  [
    2, 2, 2, '10/01/2026', 'MUQADDAS', 2, '1017100015789412',
    'SANA YOUSUF', '42301-0633320-4', '03168125822', 'RAMSUAMI',
    45300, 'OPPO A6X 6/128', '351122098765432', 6, 4800, 6750,
    'M IBAD KHAN', '42101-7547131-1', '03013321417',
    'M HASSAN', '42101-72170517', '03174732419',
    6750, 6750, 6750, 6750, 0,
  ],
];

const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, worksheet, 'Legacy Ledger');

const outPath = path.join(__dirname, 'demo_legacy_import.xlsx');
XLSX.writeFile(workbook, outPath);
console.log('Wrote', outPath);
