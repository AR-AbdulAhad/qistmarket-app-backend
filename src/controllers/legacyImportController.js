const prisma = require('../../lib/prisma');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { generateConsumerNumber, generateSmartPayConsumerNumber } = require('../utils/consumerNumberUtils');

const now = () => new Date();
const LEDGER_TOKEN_SECRET = process.env.LEDGER_TOKEN_SECRET;

// Placeholder for any Verification/Purchaser/Grantor field the Excel ledger
// never captured (father's name, employer, etc.) — deliberately a sentence,
// not blank, so it reads as "not captured yet" rather than looking like real
// data when staff open the profile later to fill it in.
const PLACEHOLDER = 'Not available — legacy import';

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

function generateOrderRef() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `QIST-${dateStr}-${randomNum}`;
}

function generateTokenNumber() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

/**
 * Builds InstallmentLedger.ledger_rows the same shape
 * deliveryCompletionService.js builds for a normal completed sale — month 0
 * is the advance, months 1..N are the installment schedule. As many months
 * (oldest-first) as `paidCount` are marked already paid, matching however
 * many of the Excel's PAY1-4 columns were filled in.
 */
function buildLedgerRows({ orderDate, advanceAmount, monthlyAmount, months, paidCount }) {
  const rows = [];
  rows.push({
    month: 0,
    label: 'Advance Payment',
    due_date: orderDate,
    amount: advanceAmount,
    status: 'paid',
    paid_at: orderDate,
    payment_method: 'Cash',
    feedback: 'Legacy import',
  });

  for (let i = 0; i < months; i += 1) {
    const isPaid = i < paidCount;
    rows.push({
      month: i + 1,
      label: `Month ${i + 1}`,
      due_date: addMonths(orderDate, i + 1),
      amount: monthlyAmount,
      status: isPaid ? 'paid' : 'pending',
      paid_at: isPaid ? addMonths(orderDate, i + 1) : null,
      payment_method: isPaid ? 'Cash' : null,
    });
  }
  return rows;
}

function required(row, field) {
  const v = row[field];
  return v !== undefined && v !== null && String(v).trim() !== '';
}

const REQUIRED_FIELDS = ['purchaser_name', 'purchaser_cnic', 'purchaser_phone', 'item_price', 'tenure_months', 'installment'];

// Every legacy row is an already-transacted historical sale, so only these
// two make sense as the batch status — every other order status either
// implies a live workflow stage (verification/delivery in progress, sent to
// an outlet) that doesn't apply to a bulk-imported paper-ledger record, or
// an outcome (cancelled/rejected/expired/returned) that isn't what this data
// represents.
const VALID_STATUSES = ['delivered', 'completed'];

async function importOneRow(row, { adminUserId, defaultStatus }) {
  for (const f of REQUIRED_FIELDS) {
    if (!required(row, f)) {
      throw Object.assign(new Error(`Missing required field: ${f}`), { httpStatus: 400 });
    }
  }

  const purchaserName = String(row.purchaser_name).trim();
  const purchaserCnic = String(row.purchaser_cnic).trim();
  const purchaserPhone = String(row.purchaser_phone).trim();
  const purchaserAddress = row.purchaser_address ? String(row.purchaser_address).trim() : PLACEHOLDER;
  const itemPrice = parseFloat(row.item_price) || 0;
  const advance = parseFloat(row.advance) || 0;
  const installment = parseFloat(row.installment) || 0;
  const months = parseInt(row.tenure_months, 10) || 0;
  const orderDate = row.order_date ? new Date(row.order_date) : now();
  const serial = row.serial ? String(row.serial).trim() : null;
  const itemModel = row.item_model ? String(row.item_model).trim() : 'N/A';

  // "remain" is the bookkeeper's authoritative running balance — it's what
  // determines how many months get marked paid, not the PAY1-4 columns
  // (those are frequently left blank/inconsistent in the paper ledger even
  // when remain is kept up to date, which is exactly what was happening on
  // real rows: PAY1-4 empty but remain correctly reflecting paid months).
  // PAY1-4 is used only as a fallback when a row has no "remain" value at all.
  const remain = row.remain !== undefined && row.remain !== null && row.remain !== '' ? parseFloat(row.remain) : null;
  let paidCount;
  if (remain !== null && installment > 0) {
    const impliedPaidAmount = itemPrice - advance - remain;
    paidCount = Math.max(0, Math.round(impliedPaidAmount / installment));
  } else {
    const paidAmountsProvided = [row.pay1, row.pay2, row.pay3, row.pay4]
      .map((v) => parseFloat(v))
      .filter((v) => !isNaN(v) && v > 0);
    paidCount = paidAmountsProvided.length;
  }
  paidCount = Math.min(paidCount, months);

  let reconciliationWarning = null;
  if (remain !== null) {
    const expectedRemain = itemPrice - advance - paidCount * installment;
    if (Math.abs(expectedRemain - remain) > 1) {
      // Only possible when remain doesn't land on a whole number of
      // installments (e.g. a partial payment was made) — paidCount above is
      // still the closest whole-months match, this just flags the row for a
      // human to double check the exact figure against the source ledger.
      reconciliationWarning = `Nearest whole-month match leaves ${expectedRemain}, sheet says remain is ${remain} — check this row's exact PAY figures.`;
    }
  }

  // Deliberately NOT wrapped in prisma.$transaction: generateConsumerNumber/
  // generateSmartPayConsumerNumber (consumerNumberUtils.js) always query
  // through the plain `prisma` client, never a `tx` — calling them from
  // inside an interactive transaction here deadlocks against this DB's
  // connection_limit:1 pool (confirmed while testing: "Timed out fetching a
  // new connection from the connection pool"). deliveryCompletionService.js
  // avoids this the same way — plain sequential creates, no wrapping
  // transaction — so this matches the rest of the codebase's real pattern
  // rather than introducing atomicity this DB setup can't actually support.
  // A row that fails partway can leave a partial record behind; the per-row
  // result below reports failure either way so it's never silently lost.

  // 1. Customer — find or create. Both cnic and mobile are unique-constrained
  // (schema: model Customer), so check both before creating.
  let customer = await prisma.customer.findFirst({
    where: { OR: [{ cnic: purchaserCnic }, { mobile: purchaserPhone }] },
  });
  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        name: purchaserName,
        cnic: purchaserCnic,
        mobile: purchaserPhone,
      },
    });
  }

  // Both valid statuses (delivered, completed) represent an already-
  // transacted sale, so the full Delivery + InstallmentLedger + ConsumerNumber
  // graph is always built. Only "delivered" sets is_delivered/delivered_at —
  // "completed" means fully paid off, not necessarily handed over on that
  // exact date.
  const isDelivered = defaultStatus === 'delivered';

  // 2. Order
  const order = await prisma.order.create({
    data: {
      order_ref: generateOrderRef(),
      token_number: generateTokenNumber(),
      customer_name: purchaserName,
      whatsapp_number: purchaserPhone,
      address: purchaserAddress,
      product_name: itemModel,
      total_amount: itemPrice,
      advance_amount: advance,
      monthly_amount: installment,
      months,
      channel: 'legacy_import',
      status: defaultStatus,
      is_delivered: isDelivered,
      delivered_at: isDelivered ? orderDate : null,
      imei_serial: serial,
      created_by_user_id: adminUserId,
      customer_id: customer.id,
      needs_media_upload: true,
      needs_location: true,
      created_at: orderDate,
    },
  });

  // 3. Verification + Purchaser + up to 2 Grantors
  const verification = await prisma.verification.create({
    data: {
      order_id: order.id,
      verification_officer_id: adminUserId,
      status: 'completed',
      start_time: orderDate,
      end_time: orderDate,
    },
  });

  await prisma.purchaserVerification.create({
    data: {
      verification_id: verification.id,
      name: purchaserName,
      father_husband_name: PLACEHOLDER,
      present_address: purchaserAddress,
      permanent_address: purchaserAddress,
      cnic_number: purchaserCnic,
      telephone_number: purchaserPhone,
      employer_name: PLACEHOLDER,
      employer_address: PLACEHOLDER,
      designation: PLACEHOLDER,
      nearest_location: PLACEHOLDER,
      is_verified: true,
    },
  });

  const grantors = [
    { name: row.grantor1_name, cnic: row.grantor1_cnic, phone: row.grantor1_phone, num: 1 },
    { name: row.grantor2_name, cnic: row.grantor2_cnic, phone: row.grantor2_phone, num: 2 },
  ].filter((g) => required({ n: g.name }, 'n'));

  for (const g of grantors) {
    const gName = String(g.name).trim();
    const gCnic = g.cnic ? String(g.cnic).trim() : PLACEHOLDER;
    const gPhone = g.phone ? String(g.phone).trim() : PLACEHOLDER;
    await prisma.grantorVerification.create({
      data: {
        verification_id: verification.id,
        grantor_number: g.num,
        name: gName,
        father_husband_name: PLACEHOLDER,
        present_address: PLACEHOLDER,
        permanent_address: PLACEHOLDER,
        cnic_number: gCnic,
        telephone_number: gPhone,
        designation: PLACEHOLDER,
        office_address: PLACEHOLDER,
        full_residential_address: PLACEHOLDER,
        relationship: PLACEHOLDER,
        nearest_location: PLACEHOLDER,
        is_verified: true,
      },
    });
  }

  // 4. Delivery — InstallmentLedger requires a real delivery_id (schema:
  // prisma/schema.prisma InstallmentLedger.delivery_id is required+unique).
  const delivery = await prisma.delivery.create({
    data: {
      order_id: order.id,
      delivery_agent_id: adminUserId,
      status: 'completed',
      start_time: orderDate,
      end_time: orderDate,
      verified: true,
      product_imei: serial,
      selected_plan: { total_amount: itemPrice, advance_amount: advance, monthly_amount: installment, months },
    },
  });

  // 5. InstallmentLedger — backfilled payment history from the sheet.
  const ledgerRows = buildLedgerRows({ orderDate, advanceAmount: advance, monthlyAmount: installment, months, paidCount });
  const imeiStr = serial ? serial.replace(/\D/g, '') : '';
  const shortId = imeiStr.length >= 6 ? imeiStr.slice(-6) : crypto.randomBytes(4).toString('hex').slice(0, 6);
  const ledgerToken = jwt.sign(
    { order_id: order.id, delivery_id: delivery.id },
    LEDGER_TOKEN_SECRET,
    { expiresIn: '730d' }
  );

  const installmentLedger = await prisma.installmentLedger.create({
    data: {
      order_id: order.id,
      delivery_id: delivery.id,
      token: ledgerToken,
      short_id: shortId,
      ledger_rows: ledgerRows,
    },
  });

  // 6. Consumer numbers — reuse the sheet's own 1BILL ID when given (it's
  // the real historical bill number customers may already know/have used),
  // otherwise generate one the same way a normal sale does.
  const billIdFromSheet = row.bill_id ? String(row.bill_id).trim() : null;
  let billConsumerNumber = billIdFromSheet;
  if (billConsumerNumber) {
    const clash = await prisma.consumerNumber.findUnique({ where: { consumer_number: billConsumerNumber } });
    if (clash) billConsumerNumber = null; // fall through to generating a fresh one below
  }
  if (!billConsumerNumber) {
    billConsumerNumber = await generateConsumerNumber(serial, purchaserPhone);
  }
  const smartPayConsumerNumber = await generateSmartPayConsumerNumber(serial, purchaserPhone);

  const dueDate = new Date();
  dueDate.setFullYear(dueDate.getFullYear() + 10);
  const firstPendingRow = ledgerRows.find((r) => r.status === 'pending');

  await prisma.consumerNumber.createMany({
    data: [billConsumerNumber, smartPayConsumerNumber].map((num) => ({
      consumer_number: num,
      ledger_id: installmentLedger.id,
      delivery_id: delivery.id,
      type: 'installment',
      customer_name: purchaserName,
      mobile_number: purchaserPhone,
      imei_serial: serial,
      amount_due: firstPendingRow ? firstPendingRow.amount : 0,
      billing_month: firstPendingRow ? `${String(new Date(firstPendingRow.due_date).getFullYear()).slice(-2)}${String(new Date(firstPendingRow.due_date).getMonth() + 1).padStart(2, '0')}` : '0000',
      due_date: firstPendingRow ? new Date(firstPendingRow.due_date) : dueDate,
      bill_status: firstPendingRow ? 'U' : 'P',
    })),
  });

  return { order_id: order.id, reconciliationWarning };
}

/**
 * POST /admin-panel/legacy-import/commit
 * body: { rows: [...], default_status }  — default_status must be one of VALID_STATUSES
 * Each row is processed independently (see importOneRow's note on why this
 * isn't wrapped in a DB transaction) so one bad row can't abort the whole
 * batch — results are returned per-row, never silently dropped.
 */
const commitLegacyImport = async (req, res) => {
  const { rows, default_status } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ success: false, message: 'No rows provided.' });
  }
  if (!VALID_STATUSES.includes(default_status)) {
    return res.status(400).json({ success: false, message: `default_status must be one of: ${VALID_STATUSES.join(', ')}.` });
  }

  const adminUserId = req.user.id;
  const results = [];

  for (let i = 0; i < rows.length; i += 1) {
    try {
      const { order_id, reconciliationWarning } = await importOneRow(rows[i], { adminUserId, defaultStatus: default_status });
      results.push({ row: i, success: true, order_id, reconciliation_warning: reconciliationWarning });
    } catch (err) {
      console.error(`Legacy import row ${i} failed:`, err);
      results.push({ row: i, success: false, error: err.message || 'Unknown error' });
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  return res.json({ success: true, message: `Imported ${succeeded}/${rows.length} row(s).`, results });
};

/**
 * GET /admin-panel/legacy-import/pending
 * Orders still needing media and/or a location captured after import.
 */
const listPendingLegacyProfiles = async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: {
        channel: 'legacy_import',
        OR: [{ needs_media_upload: true }, { needs_location: true }],
      },
      select: {
        id: true,
        order_ref: true,
        customer_name: true,
        whatsapp_number: true,
        product_name: true,
        status: true,
        needs_media_upload: true,
        needs_location: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
    });
    return res.json({ success: true, data: orders });
  } catch (error) {
    console.error('listPendingLegacyProfiles error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * POST /admin-panel/legacy-import/:orderId/mark-complete
 * Staff clicks this once they've finished adding media + location for a
 * profile via the existing verification screen — a deliberate, explicit
 * action rather than trying to auto-detect "done" across the half-dozen
 * different upload endpoints (documents, signature, photo, location).
 */
const markLegacyProfileComplete = async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.channel !== 'legacy_import') {
      return res.status(404).json({ success: false, message: 'Legacy-imported order not found.' });
    }
    await prisma.order.update({
      where: { id: orderId },
      data: { needs_media_upload: false, needs_location: false },
    });
    return res.json({ success: true, message: 'Profile marked complete.' });
  } catch (error) {
    console.error('markLegacyProfileComplete error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = { commitLegacyImport, listPendingLegacyProfiles, markLegacyProfileComplete };
