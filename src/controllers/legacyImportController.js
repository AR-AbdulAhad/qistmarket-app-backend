const prisma = require('../../lib/prisma');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { generateConsumerNumber, generateSmartPayConsumerNumber } = require('../utils/consumerNumberUtils');

const now = () => new Date();
const LEDGER_TOKEN_SECRET = process.env.LEDGER_TOKEN_SECRET;

// Placeholder for any field the sheet genuinely didn't have a column for.
// Deliberately a sentence, not blank, so it reads as "not captured yet"
// rather than looking like real data when staff open the profile later.
// Every field below can still be edited afterward on the order's own detail
// page (Purchaser/Grantor Details sections, Super Admin + status=delivered)
// — this is only what a bulk import couldn't fill in from the sheet.
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

function required(row, field) {
  const v = row[field];
  return v !== undefined && v !== null && String(v).trim() !== '';
}

// Trimmed string if the sheet gave one, otherwise the standard placeholder.
function orPlaceholder(v) {
  return v !== undefined && v !== null && String(v).trim() !== '' ? String(v).trim() : PLACEHOLDER;
}

// Trimmed string if given, otherwise null (for genuinely optional fields —
// e.g. official_number, business_name — that shouldn't get a placeholder
// since "not available" would read oddly next to a field most people just
// don't have).
function orNull(v) {
  return v !== undefined && v !== null && String(v).trim() !== '' ? String(v).trim() : null;
}

/**
 * Builds InstallmentLedger.ledger_rows the same shape
 * deliveryCompletionService.js builds for a normal completed sale — month 0
 * is the advance, months 1..N are the installment schedule. As many months
 * (oldest-first) as `paidCount` are marked already paid. This is exactly
 * what the outlet Installments table reads to compute "Next Due" (it takes
 * the first row with status:'pending', in month order), so a legacy-imported
 * order shows its next installment correctly, same as any live-created one.
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

// Full field set matching the Purchaser Details section of the order detail
// page (qistmarket-app-dashboard orders/[id]/page.tsx) — every one of these
// is independently editable there too, this is just what bulk-import can
// fill in upfront so staff aren't retyping it all by hand afterward.
function buildPurchaserData(row, { name, cnic, phone, verificationId }) {
  return {
    verification_id: verificationId,
    name,
    cnic_number: cnic,
    telephone_number: phone,
    father_husband_name: orPlaceholder(row.purchaser_father_husband_name),
    present_address: orPlaceholder(row.purchaser_address || row.purchaser_area),
    permanent_address: orPlaceholder(row.purchaser_address || row.purchaser_area),
    employment_type: null, // enum field (EMPLOYED/etc.) — left for staff to set correctly rather than guessing
    job_type: orNull(row.purchaser_job_type),
    employer_name: orPlaceholder(row.purchaser_employer_name),
    employer_address: orPlaceholder(row.purchaser_employer_address),
    designation: orPlaceholder(row.purchaser_designation),
    official_number: orNull(row.purchaser_official_number),
    business_name: orNull(row.purchaser_business_name),
    established_since: orNull(row.purchaser_established_since),
    business_address: orNull(row.purchaser_business_address),
    net_income: orNull(row.purchaser_net_income),
    years_in_company: orNull(row.purchaser_years_in_company),
    gross_salary: orNull(row.purchaser_gross_salary),
    nearest_location: orPlaceholder(row.purchaser_nearest_location || row.purchaser_area),
    permanent_area: orNull(row.purchaser_area),
    present_area: orNull(row.purchaser_area),
    is_verified: true,
  };
}

// Full field set matching a "Grantor N Details" section on the order detail
// page — shared shape for both guarantors.
function buildGrantorData(row, prefix, { name, cnic, phone, num, verificationId }) {
  const f = (suffix) => row[`${prefix}_${suffix}`];
  return {
    verification_id: verificationId,
    grantor_number: num,
    name,
    cnic_number: cnic,
    telephone_number: phone,
    father_husband_name: orPlaceholder(f('father_husband_name')),
    relationship: orPlaceholder(f('relationship')),
    present_address: orPlaceholder(f('full_residential_address')),
    permanent_address: orPlaceholder(f('full_residential_address')),
    full_residential_address: orPlaceholder(f('full_residential_address')),
    employment_type: null,
    job_type: orNull(f('job_type')),
    designation: orPlaceholder(f('designation')),
    official_number: orNull(f('official_number')),
    office_address: orPlaceholder(f('office_address')),
    company_name: orNull(f('company_name')),
    years_in_company: orNull(f('years_in_company')),
    monthly_income: orNull(f('monthly_income')),
    business_name: orNull(f('business_name')),
    established_since: orNull(f('established_since')),
    business_address: orNull(f('business_address')),
    net_income: orNull(f('net_income')),
    nearest_location: orPlaceholder(f('nearest_location')),
    is_verified: true,
  };
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
  // The paper ledger's single "Address" column is actually a neighborhood/
  // area name (e.g. "FB Area", "Gulshan-e-Iqbal"), not a street address —
  // matches Order.area, not Order.address. A full address string, if the
  // sheet has one, still wins when present.
  const purchaserAddressLine = row.purchaser_address ? String(row.purchaser_address).trim() : null;
  const purchaserArea = row.purchaser_area ? String(row.purchaser_area).trim() : null;
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

  // 2. Order — same Customer Information fields shown on the order detail
  // page: full address string if given, otherwise the structured
  // city/area/zone/house-street/gender/residential-type breakdown.
  const order = await prisma.order.create({
    data: {
      order_ref: generateOrderRef(),
      token_number: generateTokenNumber(),
      customer_name: purchaserName,
      whatsapp_number: purchaserPhone,
      alternate_contact: orNull(row.purchaser_alt_contact),
      address: purchaserAddressLine || '',
      city: orNull(row.purchaser_city),
      area: purchaserArea,
      zone: orNull(row.purchaser_zone),
      house_no: orNull(row.purchaser_house_street),
      gender: orNull(row.purchaser_gender),
      residential_type: orNull(row.purchaser_residential_type),
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

  // 3. Verification + Purchaser + up to 2 Grantors — full field set, see
  // buildPurchaserData/buildGrantorData.
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
    data: buildPurchaserData(row, {
      name: purchaserName,
      cnic: purchaserCnic,
      phone: purchaserPhone,
      verificationId: verification.id,
    }),
  });

  const grantorInputs = [
    { prefix: 'grantor1', name: row.grantor1_name, cnic: row.grantor1_cnic, phone: row.grantor1_phone, num: 1 },
    { prefix: 'grantor2', name: row.grantor2_name, cnic: row.grantor2_cnic, phone: row.grantor2_phone, num: 2 },
  ].filter((g) => required({ n: g.name }, 'n'));

  for (const g of grantorInputs) {
    await prisma.grantorVerification.create({
      data: buildGrantorData(row, g.prefix, {
        name: String(g.name).trim(),
        cnic: orPlaceholder(g.cnic),
        phone: orPlaceholder(g.phone),
        num: g.num,
        verificationId: verification.id,
      }),
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
  // short_id is unique across the whole table — a bulk import can plausibly
  // hit two rows whose last-6-serial-digits (or, with no serial, random hex
  // fallback) collide, so check-and-regenerate rather than letting the
  // create() below fail outright.
  let shortId = imeiStr.length >= 6 ? imeiStr.slice(-6) : crypto.randomBytes(4).toString('hex').slice(0, 6);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const clash = await prisma.installmentLedger.findUnique({ where: { short_id: shortId }, select: { id: true } });
    if (!clash) break;
    shortId = crypto.randomBytes(4).toString('hex').slice(0, 6);
  }
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
