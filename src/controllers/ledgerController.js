const prisma = require('../../lib/prisma');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const axios = require('axios');
const { saveOTP, verifyOTP } = require('../utils/otpUtils');
const { generateDqr } = require('../utils/smartPayGateway');
const { sendCustomerLedger, sendNextInstallmentReminder } = require('../services/watiService');
const { sendQistReceivingForPayment, sendPartialPaymentForRow, getRepresentativeOfficerDetails } = require('../utils/qistReceivingUtils');
const { sendOtp: sendOTP } = require('../services/otpDispatcher');
const { updateCashRegister } = require('../utils/cashRegisterUtils');
const { getNormalizedLedger, normalizeLedger, buildLedgerRows, computeDueAndCurrent, classifyLedgerAccountStatus } = require('../utils/ledgerUtils');
const { generateConsumerNumber, generateSmartPayConsumerNumber } = require('../utils/consumerNumberUtils');
const { logAction } = require('../utils/auditLogger');
const { syncPayTriggerAfterPayment } = require('../utils/paytriggerSyncUtils');
const { getPaymentInstructionsSettings } = require('../utils/paymentInstructionsSettingsUtils');
// Was left as an empty string, so both <img src="${logoDataURI}"> spots below
// rendered as a broken-image icon next to the "QistMarket" alt text on every
// ledger page and PDF. Points at the frontend's own already-deployed static
// asset (qistmarket-app-dashboard/public/images/logo/qist-market-logo.png) —
// same file the dashboard/complaint page use — so this backend never needs
// to host or deploy a copy of it itself.
const logoDataURI = 'https://qms.qistmarket.pk/images/logo/qist-market-logo.png';
const faviconURI = 'data:image/png;base64,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';

const LEDGER_TOKEN_SECRET = process.env.LEDGER_TOKEN_SECRET;

// Helper for current timestamp
const now = () => new Date();

// ─── Helpers ────────────────────────────────────────────────────────────────

const formatPKR = (amount) =>
  `PKR ${Number(amount || 0).toLocaleString('en-PK')}`;

const formatDate = (d) => {
  if (!d) return 'N/A';
  const date = new Date(d);
  return date.toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' });
};

const formatDatePK = (d) => formatDate(d);

const statusBadge = (status, label = null) => {
  const colors = {
    paid: '#22c55e',
    partial: '#3b82f6',
    pending: '#f59e0b',
    overdue: '#ef4444'
  };
  const color = colors[status?.toLowerCase()] || '#6b7280';
  return `<span style="background:${color};color:#fff;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;text-transform:capitalize;display:inline-block;">${label || status}</span>`;
};

// Masks a 13-digit CNIC as 42101-*******-1, keeping only the first block and last digit visible.
const maskCnic = (cnic) => {
  const digits = (cnic || '').replace(/\D/g, '');
  if (digits.length !== 13) return cnic || 'N/A';
  return `${digits.slice(0, 5)}-${'*'.repeat(7)}-${digits.slice(-1)}`;
};

const ACCOUNT_STATUS_STYLES = {
  completed: { label: 'Completed', color: '#1d4ed8', bg: '#dbeafe' },
  cancelled: { label: 'Cancelled', color: '#b91c1c', bg: '#fee2e2' },
};

// Live classification (Cleared/Defaulter/Blacklist/Overdue/Regular/Active),
// computed by classifyLedgerAccountStatus from the actual ledger rows — this
// is what the client asked the ledger to reflect, matching the same labels
// staff already see on the internal recovery dashboard.
const LEDGER_STATUS_STYLES = {
  cleared: { label: 'Cleared', color: '#1d4ed8', bg: '#dbeafe' },
  defaulter: { label: 'Defaulter', color: '#b91c1c', bg: '#fee2e2' },
  blacklist: { label: 'Blacklist', color: '#7c2d12', bg: '#ffedd5' },
  overdue: { label: 'Overdue', color: '#b91c1c', bg: '#fee2e2' },
  regular: { label: 'Regular', color: '#b45309', bg: '#fef3c7' },
  active: { label: 'Active', color: '#15803d', bg: '#dcfce7' },
};

// Order-level terminal states (cancelled/completed) take priority over the
// live payment-behavior classification below — once an order is cancelled or
// fully closed out administratively, its ledger shouldn't still be graded as
// Overdue/Defaulter etc.
const accountStatusMeta = (orderStatus, ledgerStatusKey) => {
  const orderKey = (orderStatus || '').toLowerCase();
  if (ACCOUNT_STATUS_STYLES[orderKey]) return ACCOUNT_STATUS_STYLES[orderKey];
  return LEDGER_STATUS_STYLES[ledgerStatusKey] || { label: (orderStatus || 'N/A').replace(/_/g, ' '), color: '#475569', bg: '#f1f5f9' };
};

const QIST_SUPPORT_PHONE = '0304-1111144';
// Support tab specific — a real mobile UAN and a separate WhatsApp (WATI)
// number, plus the head office address, distinct from the outlet's own
// branch phone/address shown in Branch Details.
const QIST_UAN_NUMBER = '+92 304 1111144';
const QIST_WHATSAPP_NUMBER = '0340 4444660';
const QIST_HEAD_OFFICE_ADDRESS = 'Office No. 401, Plot # 31-C, Street 5, DHA Phase 5, Badar Commercial Area, Defence Housing Authority, Karachi, 75500, Pakistan';

// ─── Shared: fetch ledger data from DB ──────────────────────────────────────

async function fetchLedger(where) {
  return prisma.installmentLedger.findUnique({
    where,
    include: {
      order: {
        include: {
          verification: {
            include: {
              purchaser: true,
              grantors: { orderBy: { grantor_number: 'asc' } },
              verification_locations: true,
            },
          },
          cash_in_hand: {
            take: 1,
            orderBy: { created_at: 'desc' },
            include: {
              officer: {
                select: { full_name: true, phone: true }
              }
            }
          },
          outlet: true,
          customer: true,
          smart_pay_qrs: {
            orderBy: { month_number: 'desc' },
            take: 1,
          },
          // Real per-transaction record (multiple payments against the same
          // installment show up as separate rows here) — ledger_rows only
          // ever holds the latest paid_amount/paid_at per month.
          payments: {
            orderBy: { paidAt: 'asc' },
          },
        },
      },
      delivery: {
        select: {
          product_imei: true,
          selected_plan: true,
          end_time: true,
          uploads: {
            where: { upload_type: 'face_photo' },
            take: 1,
            select: { file_url: true },
          },
        },
      },
      consumer_numbers: {
        orderBy: { created_at: 'asc' },
      },
    },
  });
}

// A short token can be the ledger's own short_id, OR (now that both the
// SmartPay and 1Bill consumer numbers are shown on the page — see point 13)
// the customer's 1Bill/SmartPay ID itself. Try short_id first (cheap, no
// extra join), then fall back to resolving via consumer_numbers so a
// customer entering their displayed ID directly still lands on their ledger.
//
// Deliberately NOT a fallback for old/retired short_ids — every ledger's
// short_id is now itself the real 1Bill number (see the short_id-to-1Bill
// migration), and the client explicitly wants an old pre-migration link to
// stop resolving rather than silently keep working, so this only ever
// matches a real installment/officer_cash consumer number, never a
// redirect-style row.
async function fetchLedgerByShortToken(token) {
  const bySortId = await fetchLedger({ short_id: token });
  if (bySortId) return bySortId;

  const consumer = await prisma.consumerNumber.findUnique({
    where: { consumer_number: token },
    select: { ledger_id: true, type: true },
  });
  if (!consumer?.ledger_id || consumer.type === 'legacy_short_id') return null;

  return fetchLedger({ id: consumer.ledger_id });
}

// ─── Shared: best-effort product photo lookup ───────────────────────────────

const QIST_MARKET_PRODUCT_API = 'https://api.qistmarket.pk/api/product';

// Matches vendorController's fetchApiProductMap matching rule (exact,
// case-insensitive name match) against the qistmarket.pk catalog, but only
// needs one image so it isn't worth sharing that heavier per-purchase helper.
// Tries api_product_name (the name a vendor purchase was matched against)
// before the raw product_name, since the former is the one actually
// confirmed to exist in the catalog. Never throws — a slow/unreachable
// catalog must not break the customer-facing ledger page, it just renders
// without a photo.
async function fetchProductImageUrl(productName, apiProductName) {
  const namesToTry = [apiProductName, productName]
    .filter(Boolean)
    .map((n) => n.trim().toLowerCase());
  if (!namesToTry.length) return null;

  try {
    const response = await axios.get(QIST_MARKET_PRODUCT_API, { timeout: 6000 });
    const products = Array.isArray(response.data) ? response.data : [];
    for (const name of namesToTry) {
      const match = products.find((p) => (p.name || '').trim().toLowerCase() === name);
      if (match?.ProductImage?.[0]?.url) return match.ProductImage[0].url;
    }
    return null;
  } catch (err) {
    console.warn('[LedgerController] fetchProductImageUrl failed:', err.message);
    return null;
  }
}

// ─── Shared: build HTML from ledger record (RESPONSIVE VERSION) ───────────────────────────────────

async function buildLedgerHtml(ledger, stockItem = null, productImageUrl = null) {
  const order = ledger.order;
  const delivery = ledger.delivery;
  const purchaser = order.verification?.purchaser;
  const grantors = order.verification?.grantors || [];
  const customerName = purchaser?.name || order.customer_name || 'Customer';
  const cnic = purchaser?.cnic_number || 'N/A';
  const cnicMasked = maskCnic(cnic);
  const phone = purchaser?.telephone_number || order.whatsapp_number || 'N/A';
  const address = purchaser?.present_address || order.address || 'N/A';

  const cashRecord = order.cash_in_hand?.[0];
  const collectorName = cashRecord?.officer?.full_name || null;

  let plan = null;
  if (delivery?.selected_plan) {
    try {
      plan = typeof delivery.selected_plan === 'string'
        ? JSON.parse(delivery.selected_plan)
        : delivery.selected_plan;
    } catch (e) { plan = null; }
  }

  const productName = cashRecord?.product_name
    || stockItem?.product_name
    || plan?.productName
    || plan?.product_name
    || order.product_name
    || 'N/A';

  const modelName = plan?.model || plan?.productModel || stockItem?.model || productName;

  const imei = cashRecord?.imei_serial || delivery?.product_imei || 'N/A';

  const colorVariant = (() => {
    if (cashRecord?.color_variant) {
      const parts = cashRecord.color_variant.split('|').map(s => s.trim()).filter(Boolean);
      return parts.length ? parts.join(' / ') : cashRecord.color_variant;
    }
    if (stockItem?.color_variant) {
      return stockItem.color_variant;
    }
    const color = plan?.color || plan?.productColor || plan?.color_variant || plan?.product_color;
    const variant = plan?.variant || plan?.productVariant || plan?.product_variant;
    return color ? `${color}${variant ? ' / ' + variant : ''}` : 'N/A';
  })();

  const deliveryDate = formatDate(delivery?.end_time || ledger.created_at || order.created_at);
  // Account Opened = the day the product was actually delivered to the
  // customer, not the day the order record was first created (which can be
  // days/weeks earlier, during verification/processing).
  const accountOpenedDate = deliveryDate;
  const customerSinceDate = formatDate(order.customer?.created_at || order.created_at);

  // ── Use normalized ledger for consistent financial calculations ──
  const normalized = getNormalizedLedger(ledger.ledger_rows);
  const { advance_payment: advancePayment, installment_ledger: rawInstallmentRows, rows: allRows } = normalized;

  // Real per-transaction history, grouped by installment month — the actual
  // OrderPayment table (created on every payment) is the source of truth for
  // money collected; ledger_rows.paid_amount is only a cached snapshot that
  // can drift from it (seen for real: a run of cash payments against one
  // month never made it into ledger_rows, so the row showed "—" paid while
  // its own payment history still listed every transaction). Reconcile once,
  // up front, so every number derived below — Paid/Remaining/Status per row,
  // account totals, QR amount, account status — is consistent with what
  // actually happened rather than a possibly-stale cache.
  const paymentsByMonth = new Map();
  for (const p of (order.payments || [])) {
    if (p.monthNumber == null) continue;
    if (!paymentsByMonth.has(p.monthNumber)) paymentsByMonth.set(p.monthNumber, []);
    paymentsByMonth.get(p.monthNumber).push(p);
  }
  const installmentRows = rawInstallmentRows.map((row) => {
    const monthPayments = paymentsByMonth.get(row.monthNumber) || [];
    const txnPaid = monthPayments.reduce((s, p) => s + Number(p.amount || 0), 0);
    const effectivePaid = Math.max(row.paidAmount, txnPaid);
    if (effectivePaid <= row.paidAmount) return row; // no drift — keep as-is
    const effectiveRemaining = Math.max(0, row.dueAmount - effectivePaid);
    return {
      ...row,
      paidAmount: effectivePaid,
      remainingAmount: effectiveRemaining,
      status: effectiveRemaining <= 0 ? 'paid' : 'partial',
    };
  });

  const advanceAmount = advancePayment.amount;
  const totalAmount = installmentRows.reduce((s, r) => s + r.dueAmount, 0) + advanceAmount;
  const totalInstallmentPaid = installmentRows.reduce((s, r) => s + r.paidAmount, 0);
  const totalPaidAmount = (advancePayment.paid ? advanceAmount : 0) + totalInstallmentPaid;
  const remainingAmount = Math.max(0, totalAmount - totalPaidAmount);
  const paidInstallmentCount = installmentRows.filter(r => (r.status || '').toLowerCase() === 'paid').length;

  const todayEndForArrears = new Date();
  todayEndForArrears.setHours(23, 59, 59, 999);
  let overdueAmount = 0;
  let overdueInstallmentsCount = 0;
  for (const r of installmentRows) {
    const d = r.dueDate ? new Date(r.dueDate) : null;
    const isPaid = (r.status || '').toLowerCase() === 'paid';
    if (d && !isNaN(d.getTime()) && d <= todayEndForArrears && !isPaid) {
      overdueAmount += r.remainingAmount;
      overdueInstallmentsCount += 1;
    }
  }

  const monthlyInstallment = installmentRows[0]?.dueAmount || order.monthly_amount || 0;

  // "Next Due Date" used to mean "the oldest unpaid installment's date" —
  // which can be a date that's already passed once an account falls behind,
  // reading as a stale/wrong "next" date. Split it in two: the oldest unpaid
  // row (shown as "Oldest Unpaid Due Date" only when it's actually overdue)
  // and the true next upcoming (not-yet-due) installment.
  const todayForDates = new Date();
  const oldestUnpaidRow = installmentRows.find(r => r.status !== 'paid');
  const oldestUnpaidIsOverdue = !!(oldestUnpaidRow && new Date(oldestUnpaidRow.dueDate) < todayForDates);
  const nextUpcomingRow = installmentRows.find(r => r.status !== 'paid' && new Date(r.dueDate) >= todayForDates);

  const nextDueDateLabel = oldestUnpaidIsOverdue ? 'Oldest Unpaid Due Date' : 'Next Due Date';
  const nextDueDate = oldestUnpaidIsOverdue
    ? formatDate(oldestUnpaidRow.dueDate)
    : (nextUpcomingRow ? formatDate(nextUpcomingRow.dueDate) : 'N/A');
  // Only rendered as a second line when there's genuinely something overdue
  // AND a distinct future installment to show — otherwise it would just
  // repeat nextDueDate.
  const upcomingDueDateHtml = (oldestUnpaidIsOverdue && nextUpcomingRow)
    ? `Next Upcoming: <strong>${formatDate(nextUpcomingRow.dueDate)}</strong>`
    : '';

  // Most recent payment TRANSACTION — a partial payment still stamps
  // paid_at on its row, so this must not be restricted to fully 'paid' rows
  // or the latest partial payment gets silently ignored in favour of an
  // older fully-paid installment.
  const paidDates = allRows.filter(r => r.paid_at).map(r => new Date(r.paid_at));
  const lastPaymentDate = paidDates.length ? formatDate(new Date(Math.max(...paidDates))) : 'N/A';

  const ledgerStatusKey = classifyLedgerAccountStatus(installmentRows);
  const statusMeta = accountStatusMeta(order.status, ledgerStatusKey);

  const outlet = order.outlet;
  const branchName = outlet?.name || 'N/A';
  const branchAddress = outlet?.address || 'N/A';
  // Falls back to the global support line only for branches that genuinely
  // haven't had a phone number entered yet — real per-branch contact info
  // (captured on the branch's own profile) now takes priority.
  const branchPhone = outlet?.phone || QIST_SUPPORT_PHONE;
  const mapsUrl = outlet?.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(outlet.address)}`
    : null;

  // Where the purchaser/guarantor actually were when field verification
  // captured their location — distinct from mapsUrl above (the branch's own
  // address), and from present_address (self-reported, not GPS-verified).
  const verificationLocations = order.verification?.verification_locations || [];
  const verificationMapUrl = (personType, personId) => {
    const loc = verificationLocations.find(
      (l) => l.person_type === personType && l.person_id === personId && l.latitude != null && l.longitude != null
    );
    return loc ? `https://www.google.com/maps/search/?api=1&query=${loc.latitude},${loc.longitude}` : null;
  };
  const purchaserMapUrl = purchaser ? verificationMapUrl('purchaser', purchaser.id) : null;

  // SmartPay QR is the only *QR code* gateway (the locally-built 1Bill EMVCo
  // QR was dropped for the reasons below), but the 1Bill/TPS consumer number
  // itself is real and live — tpsController.js implements the full 1Link
  // BillInquiry/BillPayment spec against it, so any bank/wallet's own "pay a
  // bill" feature can pay against that number even without a QR from us. It
  // was simply never surfaced on the ledger page before now.
  const consumerNumberRows = ledger.consumer_numbers || [];
  let smartPayConsumerNumber = consumerNumberRows.find((c) => c.consumer_number.startsWith('6500'))?.consumer_number || null;
  // Prefix-matched rather than "anything that isn't 6500…" so this can never
  // accidentally pick up some other consumer_number row (e.g. a legacy_short_id
  // one, see fetchLedgerByShortToken above) and show it as the real 1Bill ID.
  const oneBillConsumerNumber = consumerNumberRows.find((c) => c.consumer_number.startsWith('1017100015'))?.consumer_number || null;

  // Legacy/older orders can predate consistent dual consumer-number creation
  // at delivery — rather than silently showing no ID/QR at all (the
  // "inconsistent across ledgers" complaint), generate and persist a
  // SmartPay number on-demand the same way the QR itself is already
  // regenerated on-demand below.
  if (!smartPayConsumerNumber) {
    try {
      const imeiForGen = delivery?.product_imei || cashRecord?.imei_serial || null;
      const mobileForGen = purchaser?.telephone_number || order.whatsapp_number || null;
      const generated = await generateSmartPayConsumerNumber(imeiForGen, mobileForGen);
      await prisma.consumerNumber.create({
        data: {
          consumer_number: generated,
          ledger_id: ledger.id,
          delivery_id: delivery?.id || null,
          customer_name: customerName,
          mobile_number: mobileForGen || 'N/A',
          imei_serial: imeiForGen,
          amount_due: monthlyInstallment || 0,
          billing_month: String(new Date().getFullYear()).slice(-2) + String(new Date().getMonth() + 1).padStart(2, '0'),
          due_date: oldestUnpaidRow?.dueDate ? new Date(oldestUnpaidRow.dueDate) : now(),
          bill_status: 'U',
          created_at: now(),
          updated_at: now(),
        },
      });
      smartPayConsumerNumber = generated;
    } catch (genErr) {
      console.error('[LedgerController] on-demand SmartPay consumer number generation failed:', genErr);
    }
  }

  // What the QR should actually charge: arrears (everything already overdue)
  // plus the current/nearest installment — NOT the entire remaining loan
  // balance. A customer scanning to "pay now" shouldn't be shown a QR for
  // months of future installments they haven't reached yet.
  const { due: dueNowArrears, current: dueNowCurrent } = computeDueAndCurrent(installmentRows);
  const amountDueNow = dueNowArrears + dueNowCurrent;

  // The QR has to reflect what's actually owed right now — a cached QR is
  // only reused while it's both unexpired AND still for the current
  // payable-now amount; otherwise (expired, or the amount moved since it was
  // generated) it's regenerated live so the code always scans for the real
  // current amount instead of a stale one.
  const cachedSmartPayQr = order.smart_pay_qrs?.[0] || null;
  const cachedQrIsFresh =
    cachedSmartPayQr &&
    cachedSmartPayQr.amount === amountDueNow &&
    (!cachedSmartPayQr.expires_at || new Date(cachedSmartPayQr.expires_at) > now());

  let qrImageSrc = cachedQrIsFresh ? cachedSmartPayQr.qr_image_base64 : null;
  let qrProvider = qrImageSrc ? 'SmartPay' : null;

  // Generate live for the payable-now amount when there's no still-valid
  // cached QR — only ever with a real "6500"-prefixed SmartPay number, and
  // only while there's actually something due.
  if (!qrImageSrc && smartPayConsumerNumber && amountDueNow > 0) {
    try {
      const dqrRes = await generateDqr({
        consumerNumber: smartPayConsumerNumber,
        consumerDetail: customerName,
        amount: amountDueNow,
        cellNo: phone || '',
        referenceInfo: `QIST-${order.id}-${Date.now()}`.substring(0, 30),
      });
      if (dqrRes?.success && dqrRes?.qrImageBase64) {
        qrImageSrc = dqrRes.qrImageBase64;
        qrProvider = 'SmartPay';
      }
    } catch (dqrErr) {
      console.error('[LedgerController] SmartPay generateDqr error:', dqrErr);
    }
  }

  // ── Guarantor cards (real data from GrantorVerification, if any exist) ──
  const guarantorCardsHtml = grantors.length
    ? grantors.map((g, idx) => {
        const gMapUrl = verificationMapUrl(`grantor${idx + 1}`, g.id);
        return `
        <div class="guarantor-item">
          <div class="info-label" style="margin-bottom:6px;">Guarantor ${idx + 1}</div>
          <div class="info-val" style="margin-bottom:8px;">${g.name}</div>
          <div class="info-grid-2col">
            <div class="info-row"><span class="info-label">CNIC</span><span class="info-val">${maskCnic(g.cnic_number)}</span></div>
            <div class="info-row"><span class="info-label">Mobile</span><span class="info-val">${g.telephone_number || 'N/A'}</span></div>
          </div>
          ${gMapUrl ? `<a class="btn-outline" style="margin-top:10px;display:inline-block;text-align:center;" href="${gMapUrl}" target="_blank" rel="noopener">📍 Verification Location</a>` : ''}
        </div>`;
      }).join('')
    : `<p style="font-size:0.8rem;color:#94a3b8;">Koi guarantor record maujood nahi.</p>`;

  // ── Ledger rows, computed once and rendered into both a compact (mobile) and full (desktop) table ──
  const rowsMeta = installmentRows.map((row, idx) => {
    const isPaid = row.status === 'paid';
    const dueDate = new Date(row.dueDate);
    const isOverdue = !isPaid && !isNaN(dueDate.getTime()) && dueDate < todayForDates;
    const isPartial = row.paidAmount > 0 && row.remainingAmount > 0;

    let displayStatus = 'pending';
    let displayLabel = 'Pending';
    if (isPaid) {
      displayStatus = 'paid';
      displayLabel = 'Paid';
    } else if (isOverdue) {
      displayStatus = 'overdue';
      displayLabel = isPartial ? 'Partial / Overdue' : 'Overdue';
    } else if (isPartial) {
      displayStatus = 'partial';
      displayLabel = 'Partial';
    }

    // Not every paid row has a real OrderPayment transaction behind it yet
    // (older/imported payments only ever touched the cached ledger_rows
    // snapshot) — rather than hiding "View Payments" for those rows, fall
    // back to a single entry built from the row's own paid_amount/paid_at/
    // payment_method so every row that's had anything paid against it gets
    // the same "what was paid" breakdown, not just rows with 2+ real
    // transaction records.
    const monthPayments = (paymentsByMonth.get(row.monthNumber) || []);
    const paymentEntries = monthPayments.length > 0
      ? monthPayments
      : (row.paidAmount > 0 ? [{ paidAt: row.paidAt, amount: row.paidAmount, paymentMethod: row.paymentMethod }] : []);
    const paymentHistoryHtml = paymentEntries.length > 0
      ? `<details style="margin-top:4px;">
          <summary style="cursor:pointer;color:#2563eb;font-size:0.68rem;font-weight:700;">View Payments (${paymentEntries.length})</summary>
          <div style="margin-top:6px;">
            ${paymentEntries.map(p => `<div style="font-size:0.68rem;color:#334155;padding:4px 0;border-top:1px solid #f1f5f9;">${formatDate(p.paidAt)} — <strong style="color:#16a34a;">${formatPKR(p.amount)}</strong> (${p.paymentMethod || 'N/A'})</div>`).join('')}
          </div>
        </details>`
      : '';

    // The one row that's actually "due right now" (the nearest unpaid
    // installment that isn't itself overdue yet) carries forward whatever's
    // already overdue from earlier months — so THIS row's total, not the
    // bare monthly installment, is what the customer actually needs to pay
    // to get current. Every other future row stays untouched (that's the
    // "don't repeat arrears under every future row" fix from before) — only
    // the single next-due row gets this rollup.
    const isCurrentDueRow = oldestUnpaidIsOverdue && nextUpcomingRow && row.monthNumber === nextUpcomingRow.monthNumber;
    const carriedArrears = isCurrentDueRow ? overdueAmount : 0;
    const totalRowRemaining = row.remainingAmount + carriedArrears;
    const arrearsNoteHtml = carriedArrears > 0
      ? `<div style="color:#ef4444;font-size:0.65rem;font-weight:600;margin-top:2px;">+ Arrears: ${formatPKR(carriedArrears)}</div>`
      : '';

    return {
      rowNum: String(idx + 1).padStart(2, '0'),
      isAdvance: false,
      isNext: displayStatus === 'overdue' || (displayStatus === 'pending' && idx === 0),
      rowClass: (isOverdue || isCurrentDueRow) ? 'current-month' : '',
      dueDateText: formatDate(row.dueDate),
      dueAmountText: formatPKR(row.dueAmount),
      arrearsNoteHtml,
      paidText: row.paidAmount > 0 ? formatPKR(row.paidAmount) : '—',
      remainingText: totalRowRemaining > 0 ? formatPKR(totalRowRemaining) : '—',
      paymentDateText: row.paidAt ? formatDate(row.paidAt) : '—',
      paymentMethodText: row.paymentMethod || '—',
      statusHtml: statusBadge(displayStatus, displayLabel),
      paymentHistoryHtml,
      extra: idx >= 6,
    };
  });

  const mobileLedgerRowsHtml = rowsMeta.map(r => `
        <tr class="${r.rowClass} ${r.extra ? 'row-extra' : ''}">
          <td>${r.rowNum}</td>
          <td>${r.dueDateText}</td>
          <td style="color:#16a34a;font-weight:700;">${r.paidText}</td>
          <td style="color:#dc2626;font-weight:700;">${r.remainingText}${r.arrearsNoteHtml}</td>
          <td>${r.statusHtml}${r.paymentHistoryHtml}</td>
        </tr>`).join('');

  const desktopLedgerRowsHtml = rowsMeta.map(r => `
        <tr class="${r.rowClass}">
          <td>${r.rowNum}</td>
          <td>${r.dueDateText}</td>
          <td style="font-weight:700;">${r.dueAmountText}${r.arrearsNoteHtml}</td>
          <td style="color:#16a34a;">${r.paidText}</td>
          <td style="color:#dc2626;font-weight:700;">${r.remainingText}</td>
          <td>${r.paymentDateText}</td>
          <td>${r.paymentMethodText}</td>
          <td>${r.statusHtml}${r.paymentHistoryHtml}</td>
        </tr>`).join('');

  // "gdfgdfg C/O Guarantor1 C/O Guarantor2" — chained C/O per guarantor on the order.
  const grantorRelationLabel = grantors.map(g => ` C/O ${g.name}`).join('');

  // ── Reusable content blocks (shared between mobile & desktop markup) ──

  const deliveryPhotoUrl = delivery?.uploads?.[0]?.file_url || null;

  const productImageHtml = (productImageUrl || deliveryPhotoUrl)
    ? `<div style="display:flex;gap:10px;margin-bottom:14px;">
        ${productImageUrl ? `<div style="text-align:center;"><img src="${productImageUrl}" alt="${productName}" style="width:96px;height:96px;object-fit:contain;border-radius:14px;border:1px solid #e2e8f0;background:#fff;padding:6px;" /><div style="font-size:0.65rem;color:#94a3b8;margin-top:4px;">Product</div></div>` : ''}
        ${deliveryPhotoUrl ? `<div style="text-align:center;"><img src="${deliveryPhotoUrl}" alt="Customer at delivery" style="width:96px;height:96px;object-fit:cover;border-radius:14px;border:1px solid #e2e8f0;background:#fff;" /><div style="font-size:0.65rem;color:#94a3b8;margin-top:4px;">Customer</div></div>` : ''}
      </div>`
    : '';

  const productDetailsRows = `
      <div class="info-row"><span class="info-label">Product</span><span class="info-val">${productName}</span></div>
      <div class="info-row"><span class="info-label">Model</span><span class="info-val">${modelName}</span></div>
      <div class="info-row"><span class="info-label">IMEI / Serial No.</span><span class="info-val">${imei}</span></div>
      <div class="info-row"><span class="info-label">Product Price</span><span class="info-val">${formatPKR(totalAmount)}</span></div>
      ${colorVariant !== 'N/A' ? `<div class="info-row"><span class="info-label">Color / Variant</span><span class="info-val">${colorVariant}</span></div>` : ''}
      ${collectorName ? `<div class="info-row"><span class="info-label">Collected By</span><span class="info-val">${collectorName}</span></div>` : ''}`;

  const planDetailsRows = `
      <div class="info-row"><span class="info-label">Installment Plan</span><span class="info-val">${installmentRows.length} Months</span></div>
      <div class="info-row"><span class="info-label">Monthly Installment</span><span class="info-val">${formatPKR(monthlyInstallment)}</span></div>
      <div class="info-row"><span class="info-label">Total Financed</span><span class="info-val">${formatPKR(totalAmount)}</span></div>
      <div class="info-row"><span class="info-label">Advance Paid</span><span class="info-val">${formatPKR(advanceAmount)}</span></div>
      <div class="info-row"><span class="info-label">Remaining Installments</span><span class="info-val">${installmentRows.length - paidInstallmentCount} / ${installmentRows.length}</span></div>`;

  const accountSummaryRows = `
      <div class="summary-item"><span class="info-label">Total Product Price</span><span class="info-val">${formatPKR(totalAmount)}</span></div>
      <div class="summary-item"><span class="info-label">Total Paid</span><span class="info-val" style="color:#16a34a;">${formatPKR(totalPaidAmount)}</span></div>
      <div class="summary-item"><span class="info-label">Total Outstanding</span><span class="info-val" style="color:#f59e0b;">${formatPKR(remainingAmount)}</span></div>
      <div class="summary-item"><span class="info-label">Current Installment</span><span class="info-val" style="color:#2563eb;">${formatPKR(monthlyInstallment)}</span></div>
      <div class="summary-item"><span class="info-label">Total Overdue${overdueInstallmentsCount ? ` (${overdueInstallmentsCount} Installment${overdueInstallmentsCount > 1 ? 's' : ''})` : ''}</span><span class="info-val" style="color:#dc2626;">${formatPKR(overdueAmount)}</span></div>
      <div class="summary-item"><span class="info-label">${nextDueDateLabel}</span><span class="info-val"${oldestUnpaidIsOverdue ? ' style="color:#dc2626;"' : ''}>${nextDueDate}</span></div>`;

  const hirerDetailsRows = `
      <div class="info-row"><span class="info-label">Hirer Name</span><span class="info-val">${customerName}${grantorRelationLabel}</span></div>
      <div class="info-row"><span class="info-label">CNIC</span><span class="info-val">${cnicMasked}</span></div>
      <div class="info-row"><span class="info-label">Mobile Number</span><span class="info-val">${phone}</span></div>
      <div class="info-row"><span class="info-label">Address</span><span class="info-val">${address}</span></div>
      ${purchaserMapUrl ? `<a class="btn-outline" style="margin-top:6px;display:inline-block;text-align:center;" href="${purchaserMapUrl}" target="_blank" rel="noopener">📍 Verification Location</a>` : ''}`;

  const branchDetailsBlock = `
      <div class="info-row"><span class="info-label">Branch Name</span><span class="info-val">${branchName}</span></div>
      <div class="info-row"><span class="info-label">Address</span><span class="info-val">${branchAddress}</span></div>
      <div class="info-row"><span class="info-label">Phone</span><span class="info-val">${branchPhone}</span></div>
      ${mapsUrl ? `<a class="btn-outline" style="margin-top:10px;display:inline-block;text-align:center;" href="${mapsUrl}" target="_blank" rel="noopener">📍 View on Map</a>` : ''}`;

  const paymentProviderLabel = 'SmartPay';
  const displayConsumerNumber = smartPayConsumerNumber;

  // Admin-configurable via /admin/security-settings — keeps the button disabled until a link is set.
  const { payment_instructions_url: paymentInstructionsUrl } = getPaymentInstructionsSettings();
  const paymentTareeqaButtonHtml = paymentInstructionsUrl
    ? `<a href="${paymentInstructionsUrl.replace(/"/g, '&quot;')}" target="_blank" rel="noopener" class="btn-primary no-print" style="width:100%;margin-top:14px;display:block;text-align:center;text-decoration:none;box-sizing:border-box;">Payment Karne ka Tareeqa</a>`
    : `<button class="btn-primary no-print" style="width:100%;margin-top:14px;" disabled>Payment Karne ka Tareeqa</button>`;

  const payableNowHtml = amountDueNow > 0
    ? `<div class="info-label" style="margin-top:4px;">Payable Now</div>
      <div class="info-val" style="font-size:1.1rem;color:#dc2626;margin-bottom:10px;">${formatPKR(amountDueNow)}</div>`
    : '';

  const oneBillBoxHtml = oneBillConsumerNumber
    ? `<div class="info-label" style="margin-top:14px;">Your 1Bill ID</div>
      <div class="bill-id-box">
        <span id="oneBillId-${ledger.id}">${oneBillConsumerNumber}</span>
        <button class="copy-btn no-print" onclick="navigator.clipboard.writeText('${oneBillConsumerNumber}').then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);})">Copy</button>
      </div>
      <p style="font-size:0.68rem;color:#94a3b8;margin:-4px 0 4px;">Kisi bhi bank/wallet app ke bill payment section mein "QistMarket" biller select karke ye ID se bhi payment kar sakte hain.</p>`
    : '';

  const paymentBoxHtml = `
      <div class="section-title" style="color:#0f172a;">SCAN & PAY</div>
      ${payableNowHtml}
      ${displayConsumerNumber ? `
      <div class="info-label" style="margin-top:4px;">Your ${paymentProviderLabel} Consumer No</div>
      <div class="bill-id-box">
        <span id="billId-${ledger.id}">${displayConsumerNumber}</span>
        <button class="copy-btn no-print" onclick="navigator.clipboard.writeText('${displayConsumerNumber}').then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);})">Copy</button>
      </div>` : ''}
      <div class="qr-box">
        ${qrImageSrc
          ? `<img src="${qrImageSrc}" alt="Scan & Pay QR" />
        <p>Powered by <strong>${paymentProviderLabel.toUpperCase()}</strong></p>`
          : `<p style="color:#94a3b8;font-size:0.8rem;padding:20px 0;">QR abhi generate nahi ho saka. Thodi dair baad page refresh karein ya outlet se rabta karein.</p>`}
      </div>
      ${oneBillBoxHtml}
      <div class="section-title" style="color:#0f172a;margin-top:20px;">PAYMENT METHODS</div>
      <ul class="payment-methods-list">
        <li><span class="pm-dot" style="background:#16a34a;"></span>${paymentProviderLabel}</li>
        <li><span class="pm-dot" style="background:#0ea5e9;"></span>QR Payment</li>
        ${oneBillConsumerNumber ? `<li><span class="pm-dot" style="background:#7c3aed;"></span>1Bill (Bank/Wallet Bill Payment)</li>` : ''}
      </ul>
      ${paymentTareeqaButtonHtml}`;

  const noteBoxHtml = `
      <div class="note-box">
        <div class="info-label" style="color:#b45309;margin-bottom:8px;">⚠ IMPORTANT NOTE</div>
        <ul>
          <li>Sirf ${paymentProviderLabel} Consumer No aur QR par hi payment karein.</li>
          <li>Agar aap cash payment karte hain to receiving message zaroor check karein.</li>
          <li>Payment ka message na aaye to hamare bande ko payment bilkul bhi na dein.</li>
          <li>Apni payment sirf official ${paymentProviderLabel} Consumer No ya QR se hi karein.</li>
        </ul>
      </div>`;

  const realCnic = purchaser?.cnic_number || (cnic !== 'N/A' ? cnic : '');
  const realPhone = purchaser?.telephone_number || order.whatsapp_number || (phone !== 'N/A' ? phone : '');

  // Same production-safety concern as complaintController.complaintFormPage —
  // never let a missing env var leak a localhost link into a customer-facing page.
  const frontendUrl = process.env.FRONTEND_URL || 'https://qms.qistmarket.pk';
  const submitComplaintUrl = `${frontendUrl}/complaint?customer_name=${encodeURIComponent(customerName)}&customer_cnic=${encodeURIComponent(realCnic)}&mobile_number=${encodeURIComponent(realPhone)}`;

  const helpBoxHtml = `
      <div class="section-title" style="color:#dc2626;">HELP / COMPLAINT</div>
      <p style="font-size:0.78rem;color:#64748b;margin-bottom:12px;">Agar aapko kisi qisam ki pareshani hai to humse rabta karein.</p>
      <a href="${submitComplaintUrl}" target="_blank" class="btn-primary no-print" style="width:100%;margin-bottom:8px;display:block;text-align:center;text-decoration:none;box-sizing:border-box;">Submit Complaint</a>
      <button type="button" onclick="checkInlineComplaintStatus(this, '${encodeURIComponent(realCnic)}', '${encodeURIComponent(realPhone)}')" class="btn-outline no-print" style="width:100%;box-sizing:border-box;cursor:pointer;">Check Complaint Status</button>

      <div class="inline-complaint-status-box" style="display:none;margin-top:12px;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
        <div class="inline-complaint-status-loading" style="text-align:center;font-size:0.78rem;color:#64748b;padding:8px 0;font-weight:600;">
          ⏳ Complaint status search kiya ja raha hai...
        </div>
        <div class="inline-complaint-status-result"></div>
      </div>`;

  // ── Documents tab: the actual uploaded verification documents for the
  // purchaser and every guarantor on this order — not the placeholder list
  // above, which has no backing file for any of its four items yet.
  const docLink = (label, url) => url
    ? `<a href="${url}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:8px;text-decoration:none;color:#1e293b;font-weight:700;font-size:0.8rem;">
        <span>📎 ${label}</span><span style="color:#dc2626;font-size:0.7rem;font-weight:800;">VIEW →</span>
      </a>`
    : `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#f8fafc;border:1px dashed #e2e8f0;border-radius:12px;margin-bottom:8px;color:#94a3b8;font-weight:600;font-size:0.8rem;">
        <span>📎 ${label}</span><span style="font-size:0.7rem;">Not uploaded</span>
      </div>`;

  const purchaserDocsHtml = `
      ${docLink('CNIC Front', purchaser?.cnic_front_url)}
      ${docLink('CNIC Back', purchaser?.cnic_back_url)}
      ${docLink('Utility Bill', purchaser?.utility_bill_url)}
      ${docLink('Service Card', purchaser?.service_card_url)}
      ${docLink('Signature', purchaser?.signature_url)}`;

  const guarantorDocsHtml = grantors.length
    ? grantors.map((g, idx) => `
        <div style="margin-bottom:18px;">
          <div class="info-label" style="margin-bottom:8px;">Guarantor ${idx + 1} — ${g.name}</div>
          ${docLink('CNIC Front', g.cnic_front_url)}
          ${docLink('CNIC Back', g.cnic_back_url)}
          ${docLink('Utility Bill', g.utility_bill_url)}
          ${docLink('Service Card', g.service_card_url)}
          ${docLink('Signature', g.signature_url)}
        </div>`).join('')
    : `<p style="font-size:0.8rem;color:#94a3b8;">Koi guarantor documents maujood nahi.</p>`;

  const documentsTabHtml = `
      <div class="section-title" style="color:#0f172a;">📄 Documents</div>
      <div class="desktop-2col">
        <div>
          <div class="info-label" style="margin-bottom:10px;">Purchaser Documents</div>
          ${purchaserDocsHtml}
        </div>
        <div>
          <div class="info-label" style="margin-bottom:10px;">Guarantor Documents</div>
          ${guarantorDocsHtml}
        </div>
      </div>`;

  // ── Support tab: the company UAN/WhatsApp contact + a way to file a
  // complaint. Kept separate from the Complaints tab's interactive
  // submit+status box below so the two never end up sharing DOM ids.
  const supportTabHtml = `
      <div class="section-title" style="color:#0f172a;">🛟 Contact & Support</div>
      <p style="font-size:0.8rem;color:#334155;line-height:1.9;margin-bottom:16px;">
        📞 UAN: <strong>${QIST_UAN_NUMBER}</strong><br/>
        💬 WhatsApp: <strong>${QIST_WHATSAPP_NUMBER}</strong><br/>
        📍 Head Office: ${QIST_HEAD_OFFICE_ADDRESS}<br/>
        🕒 Mon - Sat (11:00 AM - 08:30 PM)
      </p>
      <a href="${submitComplaintUrl}" target="_blank" class="btn-primary no-print" style="width:100%;display:block;text-align:center;text-decoration:none;box-sizing:border-box;">Submit a Complaint</a>`;

  // "Payment Guide", "Terms & Conditions" and "Privacy Policy" were removed —
  // no such page exists anywhere in the app yet, so they were dead text. The
  // one remaining item, "Contact Branch", was dropped too — it just duplicated
  // the phone number already shown in the CONTACT US column next to this one —
  // leaving no content for this whole QUICK LINKS block, so it's gone entirely.

  const contactUsHtml = `
      <div class="section-title" style="color:#0f172a;text-align:center;">CONTACT US</div>
      <p style="font-size:0.8rem;color:#334155;line-height:1.7;text-align:center;">
        📞 ${QIST_SUPPORT_PHONE}<br/>
        📍 ${branchAddress}<br/>
        🕒 Mon - Sat (11:00 AM - 08:30 PM)
      </p>
      ${mapsUrl ? `<div style="text-align:center;"><a class="btn-outline" style="margin-top:6px;display:inline-block;text-align:center;" href="${mapsUrl}" target="_blank" rel="noopener">📍 View on Map</a></div>` : ''}`;

  // FOLLOW US removed — no real Qist Market social media URLs exist anywhere
  // in the codebase; all four icons pointed to "#" (dead links).

  const topNavHtml = `
      <nav class="desktop-topnav no-print">
        <div class="brand-area">
          <img class="logo-img" src="${logoDataURI}" alt="QistMarket" />
        </div>
        <div class="nav-links">
          <span class="nav-tab active" data-tab="dashboard" onclick="showTab('dashboard')">🏠 Dashboard</span>
          <span class="nav-tab" data-tab="ledger" onclick="showTab('ledger')">📋 Ledger</span>
          <span class="nav-tab" data-tab="payments" onclick="showTab('payments')">✉️ Payments</span>
          <span class="nav-tab" data-tab="complaints" onclick="showTab('complaints')">ℹ️ Complaints</span>
          <span class="nav-tab" data-tab="documents" onclick="showTab('documents')">📄 Documents</span>
          <span class="nav-tab" data-tab="support" onclick="showTab('support')">🛟 Support</span>
        </div>
        <div class="nav-branch">
          <span class="info-label">Branch</span>
          <div class="info-val">${branchName}</div>
        </div>
      </nav>`;

  const bottomNavHtml = `
      <nav class="mobile-bottomnav no-print">
        <span class="nav-tab active" data-tab="dashboard" onclick="showTab('dashboard')">🏠<br/>Dashboard</span>
        <span class="nav-tab" data-tab="ledger" onclick="showTab('ledger')">📋<br/>Ledger</span>
        <span class="nav-tab" data-tab="payments" onclick="showTab('payments')">✉️<br/>Payments</span>
        <span class="nav-tab" data-tab="complaints" onclick="showTab('complaints')">ℹ️<br/>Complaints</span>
        <span class="nav-tab" data-tab="documents" onclick="showTab('documents')">📄<br/>Documents</span>
        <span class="nav-tab" data-tab="support" onclick="showTab('support')">🛟<br/>Support</span>
      </nav>`;

  return `<!DOCTYPE html>
<html lang="ur" dir="ltr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>Installment Ledger — ${order.order_ref}</title>
  <link rel="icon" type="image/x-icon" href="${faviconURI}" />
  <link rel="shortcut icon" type="image/x-icon" href="${faviconURI}" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: system-ui, 'Segoe UI', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #f1f5f9;
      color: #0f172a;
      font-size: 14px;
      line-height: 1.4;
      padding-bottom: 84px; /* room for mobile bottom nav */
    }

    @media (min-width: 1024px) {
      body { padding-bottom: 24px; }
    }

    .ledger-wrapper { max-width: 1280px; margin: 0 auto; width: 100%; padding: 16px; }

    @media (min-width: 768px) { .ledger-wrapper { padding: 24px; } }

    .card-bg, .card, .info-card, .guarantor-item, .table-wrapper, .footer-note {
      background: #ffffff;
      border-radius: 22px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05), 0 10px 20px -5px rgba(0,0,0,0.03);
    }

    .card, .info-card { padding: 1.2rem; margin-bottom: 20px; }
    .guarantor-item { padding: 1rem; margin-bottom: 12px; }

    /* view toggling */
    .view-desktop { display: none; }
    @media (min-width: 1024px) {
      .view-mobile { display: none; }
      .view-desktop { display: block; }
    }

    .section-title {
      font-size: 0.7rem;
      font-weight: 800;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: #dc2626;
      margin-bottom: 14px;
      border-bottom: 1.5px solid #f1f5f9;
      padding-bottom: 10px;
    }

    .info-grid-2col { display: grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 480px) { .info-grid-2col { grid-template-columns: repeat(2, 1fr); } }

    .info-row { display: flex; flex-direction: column; gap: 4px; }
    .info-label { font-size: 0.65rem; font-weight: 600; color: #6c86a3; text-transform: uppercase; }
    .info-val { font-size: 0.85rem; font-weight: 600; color: #1e293b; word-break: break-word; }

    .status-pill { display:inline-block; padding:4px 12px; border-radius:30px; font-size:0.68rem; font-weight:800; text-transform:uppercase; }

    .btn-primary {
      background: #dc2626; color: #fff; border: none; padding: 13px 22px;
      border-radius: 60px; font-weight: 800; font-size: 0.85rem; cursor: pointer;
      text-align: center; text-decoration: none; display: inline-block;
    }
    .btn-primary:disabled { cursor: default; opacity: 0.92; }

    .btn-outline {
      background: #fff; color: #dc2626; border: 1.5px solid #fecaca; padding: 11px 22px;
      border-radius: 60px; font-weight: 800; font-size: 0.8rem; cursor: pointer;
      text-align: center; text-decoration: none;
    }
    .btn-outline:disabled { cursor: default; opacity: 0.85; }

    .bill-id-box {
      display: flex; align-items: center; justify-content: space-between;
      background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px;
      padding: 10px 14px; margin: 6px 0 16px; font-weight: 800; font-size: 0.9rem;
    }
    .copy-btn {
      background: #eef2ff; color: #3730a3; border: none; border-radius: 30px;
      padding: 5px 12px; font-size: 0.68rem; font-weight: 800; cursor: pointer;
    }

    .qr-box { text-align: center; margin: 10px 0 4px; }
    .qr-box img { width: 160px; height: 160px; object-fit: contain; }
    .qr-box p { font-size: 0.68rem; color: #94a3b8; margin-top: 6px; }

    .payment-methods-list { list-style: none; }
    .payment-methods-list li { display: flex; align-items: center; gap: 10px; padding: 7px 0; font-size: 0.8rem; font-weight: 700; color: #334155; }
    .pm-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }

    .note-box { background: #fffbeb; border: 1px solid #fde68a; border-radius: 18px; padding: 14px 16px; margin-bottom: 20px; }
    .note-box ul { list-style: disc; margin-left: 16px; font-size: 0.75rem; color: #92400e; line-height: 1.7; }

    .doc-list { list-style: none; }
    .doc-list li { padding: 7px 0; font-size: 0.8rem; font-weight: 600; }
    .doc-list li a { color: #64748b; text-decoration: none; }
    .doc-list li a:hover { color: #dc2626; text-decoration: underline; }

    .summary-item { display: flex; flex-direction: column; gap: 4px; }

    /* Table */
    .table-wrapper { overflow-x: auto; margin-bottom: 20px; -webkit-overflow-scrolling: touch; }
    .ledger-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
    .ledger-table thead tr { background: #dc2626; }
    .ledger-table th { padding: 12px 10px; text-align: left; color: white; font-weight: 700; font-size: 0.68rem; text-transform: uppercase; white-space: nowrap; }
    .ledger-table td { padding: 10px 10px; border-bottom: 1px solid #f0f2f5; }
    .ledger-table tbody tr:nth-child(even) { background-color: #fefcfc; }
    .ledger-table tbody tr.current-month { background: #fff5f0; }
    .ledger-table tbody tr.advance-row { background: #fffbeb; border-left: 3px solid #f59e0b; }
    .ledger-table tbody tr.row-extra { display: none; }
    .mobile-ledger-table.show-all tbody tr.row-extra { display: table-row; }
    tfoot tr { background: #f9fafb; font-weight: 800; border-top: 2px solid #e2e8f0; }
    tfoot td { padding: 12px 10px; }
    .view-all-btn { width: 100%; margin-top: 10px; background: #fff; border: 1.5px solid #fecaca; color: #dc2626; font-weight: 800; font-size: 0.75rem; padding: 11px; border-radius: 60px; cursor: pointer; }

    /* Applies everywhere .logo-img is used (desktop-topnav, mobile-topbar) —
       without this, an <img> with no width/height renders at its native
       pixel size, which for this logo file fills the whole viewport. */
    .logo-img { height: 34px; width: auto; }

    /* ── Mobile view ── */
    .mobile-topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .mobile-header-card { text-align: left; }
    .mobile-header-card .cust-name { font-size: 1.05rem; font-weight: 800; }
    .mobile-header-card .cust-sub { font-size: 0.72rem; color: #64748b; margin-top: 2px; }
    .mobile-outstanding { background: #dc2626; color: #fff; border-radius: 18px; padding: 16px; text-align: center; margin: 14px 0; }
    .mobile-outstanding .amt { font-size: 1.7rem; font-weight: 900; }
    .mobile-outstanding .lbl { font-size: 0.68rem; text-transform: uppercase; opacity: 0.85; }
    .mobile-bottomnav {
      position: fixed; bottom: 0; left: 0; right: 0; background: #fff; border-top: 1px solid #eef2f7;
      display: flex; justify-content: space-around; padding: 6px 0 8px; font-size: 0.54rem; font-weight: 700; color: #94a3b8; z-index: 20;
    }
    .mobile-bottomnav span { text-align: center; line-height: 1.4; cursor: pointer; flex: 1; }
    .mobile-bottomnav span.active { color: #dc2626; }
    .desktop-topnav .nav-links .nav-tab { cursor: pointer; }

    /* ── Desktop view ── */
    .desktop-topnav {
      display: flex; align-items: center; justify-content: space-between; background: #fff;
      border-radius: 20px; padding: 14px 26px; margin-bottom: 20px;
    }
    .desktop-topnav .nav-links { display: flex; gap: 22px; font-size: 0.78rem; font-weight: 700; color: #64748b; }
    .desktop-topnav .nav-links .active { color: #dc2626; }
    .desktop-topnav .nav-branch { text-align: right; }

    .desktop-header-card { display: flex; flex-wrap: wrap; gap: 20px; justify-content: space-between; align-items: center; }
    .desktop-header-card .cust-name { font-size: 1.15rem; font-weight: 800; }
    .desktop-header-card .cust-meta { display: flex; gap: 28px; margin-top: 12px; flex-wrap: wrap; }
    .desktop-outstanding { text-align: right; }
    .desktop-outstanding .amt { font-size: 1.9rem; font-weight: 900; color: #dc2626; }
    .desktop-outstanding .lbl { font-size: 0.68rem; color: #64748b; text-transform: uppercase; }

    .desktop-grid { display: grid; grid-template-columns: 1fr; gap: 22px; align-items: start; }
    @media (min-width: 1024px) { .desktop-grid { grid-template-columns: 2fr 1fr; } }

    .desktop-2col { display: grid; grid-template-columns: 1fr; gap: 20px; }
    @media (min-width: 640px) { .desktop-2col { grid-template-columns: repeat(2, 1fr); } }

    .desktop-3col { display: grid; grid-template-columns: 1fr; gap: 20px; }
    @media (min-width: 900px) { .desktop-3col { grid-template-columns: repeat(3, 1fr); } }

    .summary-bar { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
    @media (min-width: 640px) { .summary-bar { grid-template-columns: repeat(3, 1fr); } }
    @media (min-width: 1024px) { .summary-bar { grid-template-columns: repeat(6, 1fr); } }

    .footer-cols { display: grid; grid-template-columns: 1fr; gap: 24px; }

    /* Print */
    @media print {
      body { background: #fff; padding: 0; }
      .no-print, .mobile-bottomnav, .desktop-topnav { display: none !important; }
      .view-desktop { display: block !important; }
      .view-mobile { display: none !important; }
      .desktop-grid { grid-template-columns: 1fr !important; }
      .card, .info-card, .table-wrapper, .footer-note { box-shadow: none; border: 1px solid #ddd; break-inside: avoid; }
      .ledger-table th { background: #333 !important; color: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      /* Printing/saving as PDF should include every tab's content, not just
         whichever one happens to be active on screen. */
      .tab-panel { display: block !important; }
    }
  </style>
</head>
<body>
<div class="ledger-wrapper">

  <!-- ══════════════════ MOBILE VIEW ══════════════════ -->
  <div class="view-mobile">

    <div class="mobile-topbar">
      <img class="logo-img" src="${logoDataURI}" alt="QistMarket" style="height:34px;" />
      <span style="font-size:1.3rem;color:#64748b;">☰</span>
    </div>

    <div class="card mobile-header-card">
      <div class="cust-name">${customerName}${grantorRelationLabel}</div>
      <div class="cust-sub">Order No. <strong>${order.order_ref}</strong> &nbsp;•&nbsp; <span class="status-pill" style="background:${statusMeta.bg};color:${statusMeta.color};">${statusMeta.label}</span></div>
      <div class="cust-sub" style="margin-top:6px;${oldestUnpaidIsOverdue ? 'color:#dc2626;font-weight:700;' : ''}">${nextDueDateLabel}: <strong>${nextDueDate}</strong></div>
      ${upcomingDueDateHtml ? `<div class="cust-sub" style="margin-top:2px;">${upcomingDueDateHtml}</div>` : ''}
    </div>

    <div class="mobile-outstanding">
      <div class="amt">${formatPKR(remainingAmount)}</div>
      <div class="lbl">Total Outstanding</div>
    </div>

    <div class="card tab-panel" data-tab="dashboard">
      <div class="section-title">📦 Product Details</div>
      ${productImageHtml}
      <div class="info-grid-2col">${productDetailsRows}</div>
    </div>

    <div class="card tab-panel" data-tab="dashboard">
      <div class="section-title">🗂 Plan Details</div>
      <div class="info-grid-2col">${planDetailsRows}</div>
    </div>

    <div class="card tab-panel" data-tab="dashboard">
      <div class="section-title">📍 Branch Details</div>
      <div class="info-grid-2col">${branchDetailsBlock}</div>
    </div>

    <div class="card tab-panel" data-tab="dashboard,ledger">
      <div class="section-title">📊 Account Summary</div>
      <div class="summary-bar">${accountSummaryRows}</div>
    </div>

    <div class="card tab-panel" data-tab="dashboard,ledger">
      <div class="section-title">🧾 Installment / Payment Ledger</div>
      <div class="table-wrapper" style="box-shadow:none;">
        <table class="ledger-table mobile-ledger-table" id="mobileLedgerTable">
          <thead><tr><th>#</th><th>Due Date</th><th>Paid</th><th>Remaining</th><th>Status</th></tr></thead>
          <tbody>${mobileLedgerRowsHtml}</tbody>
        </table>
      </div>
      ${rowsMeta.some(r => r.extra) ? `<button class="view-all-btn no-print" onclick="document.getElementById('mobileLedgerTable').classList.toggle('show-all'); this.textContent = this.textContent.indexOf('All') > -1 ? 'Hide Payments' : 'View All Payments';">View All Payments</button>` : ''}
    </div>

    <div class="card tab-panel" data-tab="dashboard,payments">${paymentBoxHtml}</div>
    <div class="tab-panel" data-tab="dashboard,payments">${noteBoxHtml}</div>

    <div class="card tab-panel" data-tab="dashboard,complaints">${helpBoxHtml}</div>

    <div class="card tab-panel" data-tab="dashboard,documents">${documentsTabHtml}</div>

    <div class="card tab-panel" data-tab="dashboard,support">${supportTabHtml}</div>

    ${bottomNavHtml}
  </div>

  <!-- ══════════════════ DESKTOP VIEW ══════════════════ -->
  <div class="view-desktop">

    ${topNavHtml}

    <div class="card desktop-header-card">
      <div>
        <div class="cust-name">${customerName}${grantorRelationLabel}</div>
        <div class="cust-meta">
          <div><span class="info-label">Account / Order No.</span><br/><span class="info-val">${order.order_ref}</span></div>
          <div><span class="info-label">CNIC (Hirer)</span><br/><span class="info-val">${cnicMasked}</span></div>
          <div><span class="info-label">Mobile Number</span><br/><span class="info-val">${phone}</span></div>
        </div>
        <div class="cust-meta" style="margin-top:14px;">
          <div><span class="info-label">Account Opened</span><br/><span class="info-val">${accountOpenedDate}</span></div>
          <div><span class="info-label">Last Payment</span><br/><span class="info-val">${lastPaymentDate}</span></div>
          <div><span class="info-label">Customer Since</span><br/><span class="info-val">${customerSinceDate}</span></div>
          <div><span class="info-label">Account Status</span><br/><span class="status-pill" style="background:${statusMeta.bg};color:${statusMeta.color};">${statusMeta.label}</span></div>
        </div>
      </div>
      <div class="desktop-outstanding">
        <div class="lbl">Total Outstanding</div>
        <div class="amt">${formatPKR(remainingAmount)}</div>
        <div class="info-label" style="margin-top:6px;${oldestUnpaidIsOverdue ? 'color:#dc2626;' : ''}">${nextDueDateLabel}: <strong>${nextDueDate}</strong></div>
        ${upcomingDueDateHtml ? `<div class="info-label" style="margin-top:2px;">${upcomingDueDateHtml}</div>` : ''}
      </div>
    </div>

    <div class="desktop-grid">
      <div>
        <div class="card tab-panel" data-tab="dashboard">
          <div class="desktop-2col">
            <div>
              <div class="section-title">📦 Product Details</div>
              ${productImageHtml}
              <div class="info-grid-2col">${productDetailsRows}</div>
            </div>
            <div>
              <div class="section-title">🗂 Plan Details</div>
              <div class="info-grid-2col">${planDetailsRows}</div>
            </div>
          </div>
        </div>

        <div class="card tab-panel" data-tab="dashboard">
          <div class="desktop-3col">
            <div>
              <div class="section-title">👤 Hirer / Purchaser Details</div>
              <div class="info-grid-2col" style="grid-template-columns:1fr;">${hirerDetailsRows}</div>
            </div>
            <div>
              <div class="section-title">🛡 Guarantor Details</div>
              ${guarantorCardsHtml}
            </div>
            <div>
              <div class="section-title">📍 Branch Details</div>
              <div class="info-grid-2col" style="grid-template-columns:1fr;">${branchDetailsBlock}</div>
            </div>
          </div>
        </div>

        <div class="card tab-panel" data-tab="dashboard,ledger">
          <div class="section-title">📊 Account Summary</div>
          <div class="summary-bar">${accountSummaryRows}</div>
        </div>

        <div class="card tab-panel" data-tab="dashboard,ledger" style="padding:0;overflow:hidden;">
          <div style="padding:1.2rem 1.2rem 0;">
            <div class="section-title" style="margin-bottom:0;border-bottom:none;padding-bottom:0;">🧾 Installment / Payment Ledger</div>
          </div>
          <div class="table-wrapper" style="box-shadow:none;border-radius:0;margin:14px 0 0;">
            <table class="ledger-table">
              <thead><tr><th>#</th><th>Due Date</th><th>Installment</th><th>Paid Amount</th><th>Remaining</th><th>Payment Date</th><th>Payment Method</th><th>Status</th></tr></thead>
              <tbody>${desktopLedgerRowsHtml}</tbody>
              <tfoot>
                <tr>
                  <td colspan="2"><strong>Total</strong></td>
                  <td><strong>${formatPKR(totalAmount)}</strong></td>
                  <td><strong>${formatPKR(totalPaidAmount)}</strong></td>
                  <td colspan="4"><strong>Outstanding: ${formatPKR(remainingAmount)}</strong></td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div style="height:1.2rem;"></div>
        </div>

        <div class="card tab-panel" data-tab="dashboard,documents">${documentsTabHtml}</div>
      </div>

      <div id="desktop-pay">
        <div class="card tab-panel" data-tab="dashboard,payments">${paymentBoxHtml}</div>
        <div class="tab-panel" data-tab="dashboard,payments">${noteBoxHtml}</div>
        <div class="card tab-panel" data-tab="dashboard,complaints">${helpBoxHtml}</div>
        <div class="card tab-panel" data-tab="dashboard,support">${supportTabHtml}</div>
      </div>
    </div>

    <div class="card footer-cols">
      <div>${contactUsHtml}</div>
    </div>

  </div>
</div>
<script>
function showTab(tab) {
  // A panel can belong to more than one tab (e.g. "dashboard,payments") so
  // Dashboard keeps showing everything, while Payments/Ledger/etc. still
  // narrow down to just their own section — data-tab is a comma list here,
  // not a single value.
  document.querySelectorAll('.tab-panel').forEach(function (el) {
    var tabs = (el.getAttribute('data-tab') || '').split(',');
    el.style.display = (tabs.indexOf(tab) !== -1) ? '' : 'none';
  });
  document.querySelectorAll('.nav-tab').forEach(function (el) {
    if (el.getAttribute('data-tab') === tab) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });
}
showTab('dashboard');

async function checkInlineComplaintStatus(btn, cnicVal, phoneVal) {
  // The Help/Complaint block is rendered twice in this document (once for
  // the mobile layout, once for the desktop layout — only one is visible at
  // a time via CSS). Looking the box up by id would always hit whichever
  // copy comes first in the DOM, even if the user clicked the other one's
  // button — so find it relative to the button that was actually clicked.
  var box = btn.nextElementSibling;
  var loading = box ? box.querySelector('.inline-complaint-status-loading') : null;
  var resultEl = box ? box.querySelector('.inline-complaint-status-result') : null;

  if (!box || !resultEl) return;

  if (box.style.display === 'block' && resultEl.dataset.fetched === 'true') {
    box.style.display = 'none';
    resultEl.dataset.fetched = 'false';
    return;
  }

  box.style.display = 'block';
  loading.style.display = 'block';
  resultEl.innerHTML = '';

  // A complaint only needs mobile_number filled in (customer_cnic is
  // optional), so searching by CNIC alone can miss real complaints filed
  // under the same phone but a different/no CNIC. Search both identifiers
  // and merge the results (deduped by complaint_id) rather than falling
  // back to phone only when the CNIC looks unusable.
  var cnicQuery = decodeURIComponent(cnicVal || '');
  if (!cnicQuery || cnicQuery === 'N/A' || cnicQuery.indexOf('*') !== -1) cnicQuery = '';
  var phoneQuery = decodeURIComponent(phoneVal || '');
  if (!phoneQuery || phoneQuery === 'N/A') phoneQuery = '';

  var queries = [];
  if (cnicQuery) queries.push(cnicQuery);
  if (phoneQuery && phoneQuery !== cnicQuery) queries.push(phoneQuery);

  try {
    var responses = await Promise.all(queries.map(function (q) {
      return fetch('/api/complaints/public/search?query=' + encodeURIComponent(q)).then(function (r) { return r.json(); });
    }));
    loading.style.display = 'none';
    resultEl.dataset.fetched = 'true';

    var seen = {};
    var complaints = [];
    responses.forEach(function (data) {
      if (data.success && data.data) {
        data.data.forEach(function (cmp) {
          if (!seen[cmp.complaint_id]) {
            seen[cmp.complaint_id] = true;
            complaints.push(cmp);
          }
        });
      }
    });

    if (complaints.length > 0) {
      var html = '<div style="font-size:0.75rem;font-weight:800;color:#0f172a;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;">Found ' + complaints.length + ' Complaint(s):</div>';
      complaints.forEach(function(cmp) {
        var statusBg = '#fef3c7';
        var statusColor = '#b45309';
        var st = (cmp.status || '').toLowerCase();
        if (st === 'assigned' || st === 'in progress') { statusBg = '#dbeafe'; statusColor = '#1d4ed8'; }
        else if (st === 'resolved' || st === 'solved') { statusBg = '#dcfce7'; statusColor = '#15803d'; }
        else if (st === 'rejected') { statusBg = '#ffe4e6'; statusColor = '#e11d48'; }

        var dateStr = new Date(cmp.created_at).toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' });

        html += '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px;margin-bottom:10px;font-size:0.78rem;box-shadow:0 1px 2px rgba(0,0,0,0.03);">' +
                  '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;">' +
                    '<span style="font-weight:800;color:#0f172a;font-size:0.8rem;">' + cmp.complaint_id + '</span>' +
                    '<span style="background:' + statusBg + ';color:' + statusColor + ';padding:3px 10px;border-radius:20px;font-size:0.65rem;font-weight:800;text-transform:uppercase;">' + cmp.status + '</span>' +
                  '</div>' +
                  '<div style="color:#64748b;font-size:0.7rem;margin-bottom:6px;font-weight:600;">📅 Date: ' + dateStr + '</div>' +
                  '<div style="color:#334155;background:#f8fafc;padding:8px 10px;border-radius:8px;margin-bottom:6px;word-break:break-word;line-height:1.4;">' + (cmp.description || '') + '</div>' +
                  (cmp.resolution_note ? '<div style="color:#15803d;background:#f0fdf4;border:1px solid #bbf7d0;padding:8px 10px;border-radius:8px;font-size:0.72rem;margin-top:6px;"><strong>Note:</strong> ' + cmp.resolution_note + '</div>' : '') +
                '</div>';
      });
      resultEl.innerHTML = html;
    } else {
      resultEl.innerHTML = '<div style="font-size:0.78rem;color:#64748b;text-align:center;padding:8px 0;font-weight:600;">Is account ke khilaf koi complaint registered nahi hai.</div>';
    }
  } catch (err) {
    loading.style.display = 'none';
    resultEl.innerHTML = '<div style="font-size:0.75rem;color:#dc2626;text-align:center;padding:6px 0;">Complaint status fetch nahi ho saka. Please try again.</div>';
  }
}
</script>
</body>
</html>`;
}

// ─── GET /api/ledger/:token  (legacy — HTML view with token) ─────────────────

const viewLedger = async (req, res) => {
  const { token } = req.params;

  try {
    let ledger = null;
    
    // Check if it's a short_id (JWT tokens are long, short_ids are typically 6-10 chars)
    if (token.length < 50) {
        ledger = await fetchLedgerByShortToken(token);
    } else {
        // Fallback to legacy JWT token
        let decoded;
        try {
          decoded = jwt.verify(token, LEDGER_TOKEN_SECRET);
        } catch (err) {
          return res.status(401).send(renderErrorPage('Link invalid ya expire ho gaya hai.'));
        }
        ledger = await fetchLedger({ order_id: parseInt(decoded.order_id) });
    }

    if (!ledger) {
      return res.status(404).send(renderErrorPage('Ledger nahi mila. Meherbani karke support se rabta karen.'));
    }

    const stockItem = ledger.delivery?.product_imei
      ? await prisma.outletInventory.findFirst({ where: { imei_serial: ledger.delivery.product_imei } })
      : null;
    const productImageUrl = await fetchProductImageUrl(
      stockItem?.product_name || ledger.order.product_name,
      stockItem?.api_product_name
    );
    const html = await buildLedgerHtml(ledger, stockItem, productImageUrl);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (error) {
    console.error('[LedgerController] viewLedger error:', error);
    return res.status(500).send(renderErrorPage('Server error. Meherbani karke baad mein try karen.'));
  }
};

// ─── GET /api/ledger/pdf/:shortId  (new — direct PDF download) ───────────────

const downloadLedgerPdf = async (req, res) => {
  const { shortId } = req.params;

  try {
    const ledger = await fetchLedgerByShortToken(shortId);
    if (!ledger) {
      return res.status(404).send(renderErrorPage('Ledger nahi mila. Meherbani karke support se rabta karen.'));
    }

    const stockItem = ledger.delivery?.product_imei
      ? await prisma.outletInventory.findFirst({ where: { imei_serial: ledger.delivery.product_imei } })
      : null;
    const productImageUrl = await fetchProductImageUrl(
      stockItem?.product_name || ledger.order.product_name,
      stockItem?.api_product_name
    );
    const html = await buildLedgerHtml(ledger, stockItem, productImageUrl);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16px', bottom: '16px', left: '16px', right: '16px' },
    });
    await browser.close();

    const orderRef = ledger.order?.order_ref || shortId;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="QistMarket-Ledger-${orderRef}.pdf"`);
    return res.send(pdf);
  } catch (error) {
    console.error('[LedgerController] downloadLedgerPdf error:', error);
    return res.status(500).send(renderErrorPage('PDF generate karne mein masla. Baad mein try karen.'));
  }
};

// ─── Error Page (responsive) ─────────────────────────────────────────────────

function renderErrorPage(message) {
  const waNumber = QIST_WHATSAPP_NUMBER.replace(/\D/g, '');
  const waLink = `https://wa.me/92${waNumber.replace(/^0/, '')}`;
  const telLink = `tel:${QIST_UAN_NUMBER.replace(/\s/g, '')}`;

  return `<!DOCTYPE html><html lang="ur" dir="ltr"><head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>Ledger Nahi Mila — QistMarket</title>
  <link rel="icon" type="image/x-icon" href="${faviconURI}" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, 'Segoe UI', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #f1f5f9; color: #0f172a;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      padding: 24px;
    }
    .box {
      background: #fff; border-radius: 24px; max-width: 420px; width: 100%;
      padding: 36px 28px; text-align: center;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05), 0 10px 25px -5px rgba(0,0,0,0.06);
    }
    .logo-img { height: 32px; width: auto; margin-bottom: 22px; }
    .icon-badge {
      width: 64px; height: 64px; border-radius: 50%; background: #fee2e2;
      display: flex; align-items: center; justify-content: center;
      font-size: 30px; margin: 0 auto 18px;
    }
    h1 { font-size: 20px; font-weight: 800; color: #0f172a; margin-bottom: 10px; }
    p.msg { color: #64748b; font-size: 14.5px; line-height: 1.6; margin-bottom: 26px; }
    .actions { display: flex; flex-direction: column; gap: 10px; }
    .btn-primary, .btn-outline {
      display: block; padding: 13px 20px; border-radius: 60px; font-weight: 800;
      font-size: 0.85rem; text-decoration: none; text-align: center;
    }
    .btn-primary { background: #dc2626; color: #fff; }
    .btn-outline { background: #fff; color: #dc2626; border: 1.5px solid #fecaca; }
    .support-hours { margin-top: 22px; font-size: 12.5px; color: #94a3b8; }
    .footer-brand { margin-top: 6px; font-size: 12px; color: #cbd5e1; font-weight: 700; letter-spacing: 0.3px; }
    @media (max-width: 480px) { .box { padding: 28px 20px; } h1 { font-size: 18px; } }
  </style></head>
  <body>
    <div class="box">
      <img class="logo-img" src="${logoDataURI}" alt="QistMarket" />
      <div class="icon-badge">🔍</div>
      <h1>Ledger Nahi Mila</h1>
      <p class="msg">${message}</p>
      <div class="actions">
        <a class="btn-primary" href="${telLink}">📞 Call Support: ${QIST_UAN_NUMBER}</a>
        <a class="btn-outline" href="${waLink}" target="_blank" rel="noopener">💬 WhatsApp: ${QIST_WHATSAPP_NUMBER}</a>
      </div>
      <p class="support-hours">🕒 Mon - Sat (11:00 AM - 08:30 PM)</p>
      <p class="footer-brand">QIST MARKET</p>
    </div>
  </body></html>`;
}

const generateInstallmentPaymentOtp = async (req, res) => {
  const { order_id } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        verification: { include: { purchaser: true } }
      }
    });

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
    if (!phone) return res.status(400).json({ success: false, message: 'Customer phone number not found' });

    const otp = await saveOTP(phone, 'installment_payment');
    await sendOTP(phone, otp);

    return res.json({ success: true, message: 'OTP sent to customer' });
  } catch (error) {
    console.error('generateInstallmentPaymentOtp error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const verifyInstallmentPaymentOtp = async (req, res) => {
  const { order_id, month_number, otp, feedback, payment_method = 'Cash', amount } = req.body;
  const outlet_id = req.user.outlet_id;

  if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user' });

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        verification: { include: { purchaser: true } },
        installment_ledger: true
      }
    });

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
    const verification = await verifyOTP(phone, otp, 'installment_payment');

    if (!verification.valid) {
      return res.status(400).json({ success: false, message: verification.message });
    }

    const ledger = order.installment_ledger;
    if (!ledger) return res.status(404).json({ success: false, message: 'Ledger not found' });

    let rows = normalizeLedger(Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : []);
    const rowIndex = rows.findIndex(r => (r.month == month_number || r.monthNumber == month_number));

    if (rowIndex === -1) return res.status(404).json({ success: false, message: 'Installment month not found in ledger' });
    if (rows[rowIndex].status === 'paid') return res.status(400).json({ success: false, message: 'Installment already paid' });

    const dueAmount = parseFloat(rows[rowIndex].amount || rows[rowIndex].dueAmount || 0);
    const existingPaid = parseFloat(rows[rowIndex].paid_amount || 0);
    const payingNow = amount !== undefined ? parseFloat(amount) : (dueAmount - existingPaid);
    const totalPaid = existingPaid + payingNow;

    if (totalPaid > dueAmount + 1) {
      return res.status(400).json({ success: false, message: `Payment exceeds due amount. Remaining is ${dueAmount - existingPaid}` });
    }

    // Update current row
    rows[rowIndex].paid_amount = totalPaid;
    rows[rowIndex].paid_at = now();
    rows[rowIndex].payment_method = payment_method;
    rows[rowIndex].feedback = feedback;

    if (totalPaid >= dueAmount) {
      rows[rowIndex].status = 'paid';
    } else if (totalPaid > 0) {
      rows[rowIndex].status = 'partial';
    } else {
      rows[rowIndex].status = 'pending';
    }

    // Save Ledger with explicit updated_at
    await prisma.installmentLedger.update({
      where: { id: ledger.id },
      data: {
        ledger_rows: rows,
        updated_at: now()   // ✅ explicit updated_at
      }
    });

    // Create OrderPayment record with explicit timestamps
    await prisma.orderPayment.create({
      data: {
        order_id: order.id,
        paymentType: 'installment',
        monthNumber: parseInt(month_number),
        amount: parseFloat(payingNow),
        paymentMethod: payment_method,
        collectedBy_id: req.user.id,
        created_at: now(),   // ✅ explicit created_at
        paidAt: now()        // ✅ explicit paidAt
      }
    });

    // Update Cash Register
    await updateCashRegister(null, outlet_id, 'installments_received', payingNow, 'add');

    const imeiSerial = order.cash_in_hand?.[0]?.imei_serial || order.delivery?.product_imei || order.imei_serial || null;
    if (imeiSerial && totalPaid >= dueAmount) {
      syncPayTriggerAfterPayment({ imeiSerial, order, rows, rowIndex, month_number, phone });
    }

    const customerName = order.verification?.purchaser?.name || order.customer_name;
    const paymentTxnId = `${order.order_ref}-M${month_number}-${Date.now().toString(36).toUpperCase()}`;
    const rep = await getRepresentativeOfficerDetails(req.user, outlet_id);
    if (totalPaid >= dueAmount) {
      sendQistReceivingForPayment(phone, {
        order,
        ledger,
        rows,
        rowIndex,
        customerName,
        productName: order.product_name,
        paidAmount: payingNow,
        paymentMethod: payment_method,
        paymentDate: new Date().toLocaleDateString('en-PK'),
        transactionId: paymentTxnId,
        representativeName: rep.name,
        representativeNumber: rep.phone,
      }).catch(err => console.error('Wati Qist Receiving Error:', err));
    } else {
      sendPartialPaymentForRow(phone, {
        order,
        ledger,
        rows,
        rowIndex,
        customerName,
        productName: order.product_name,
        paidAmount: payingNow,
        paymentMethod: payment_method,
        paymentDate: new Date().toLocaleDateString('en-PK'),
        transactionId: paymentTxnId,
        representativeName: rep.name,
        representativeNumber: rep.phone,
      }).catch(err => console.error('Wati Partial Payment Error:', err));
    }

    // Send Next Month Reminder if exists — skipped on the full-paid branch
    // above since sendQistReceiving already carries the next-installment info.
    const nextRow = rows[rowIndex + 1];
    const ledgerUrl = ledger.short_id ? `${ledger.short_id}` : null;

    if (nextRow && totalPaid < dueAmount) {
      sendNextInstallmentReminder(phone, {
        customerName,
        productName: order.product_name,
        monthlyAmount: nextRow.amount || nextRow.dueAmount,
        dueDate: new Date(nextRow.due_date || nextRow.dueDate).toLocaleDateString('en-PK'),
        ledgerUrl
      });
    }

    await logAction(
      req,
      'INSTALLMENT_COLLECTION',
      `Collected PKR ${payingNow} from ${customerName} for order ${order.order_ref} at outlet. (Month: ${month_number})`,
      order.id,
      'Order'
    );

    return res.json({ success: true, message: 'Payment processed successfully' });
  } catch (error) {
    console.error('verifyInstallmentPaymentOtp error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * Manually send ledger via WhatsApp
 * POST /api/ledger/:shortId/send
 */
const sendLedgerToCustomer = async (req, res) => {
  try {
    const { shortId } = req.params;
    const { targetPhone } = req.body; // 'primary', 'alternate', or 'both'

    const ledger = await fetchLedger({ short_id: shortId });
    if (!ledger) {
      return res.status(404).json({ success: false, message: 'Ledger not found' });
    }

    const order = ledger.order;
    const purchaser = order.verification?.purchaser;
    const customerName = purchaser?.name || 'Customer';
    const primaryPhone = purchaser?.telephone_number || order.whatsapp_number;
    const altPhone = purchaser?.alternate_phone_number;

    let phonesToSend = [];
    if (targetPhone === 'primary' && primaryPhone) phonesToSend.push(primaryPhone);
    else if (targetPhone === 'alternate' && altPhone) phonesToSend.push(altPhone);
    else if (targetPhone === 'both') {
      if (primaryPhone) phonesToSend.push(primaryPhone);
      if (altPhone) phonesToSend.push(altPhone);
    } else if (!targetPhone) {
      // default to primary
      if (primaryPhone) phonesToSend.push(primaryPhone);
    }

    if (phonesToSend.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid phone numbers found to send to' });
    }

    const normalized = getNormalizedLedger(ledger.ledger_rows);
    const ledgerUrl = `${shortId}`;

    const sendPromises = phonesToSend.map(phone =>
      sendCustomerLedger(phone, {
        customerName: customerName,
        orderRef: order.order_ref,
        itemName: order.product_name || 'N/A',
        remainingBalance: normalized.summary.grandTotalRemaining,
        ledgerUrl,
      })
    );

    await Promise.allSettled(sendPromises);

    return res.json({ success: true, message: `Ledger sent to ${phonesToSend.length} number(s) successfully` });
  } catch (error) {
    console.error('sendLedgerToCustomer error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

function addMonthsToDate(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

// Admin-direct ledger correction — Super Admin only. Unlike every payment
// endpoint above (which cascades one payment across months and maintains
// the FIFO waterfall), this is a raw field editor: each row's amount/
// paid_amount/due_date/payment_method/feedback is taken exactly as sent,
// and `status` is always recomputed from amount vs paid_amount server-side
// (never trusted from the client) — the same rule normalizeLedger already
// uses for display, so a row can never end up with a status that disagrees
// with its own amounts. Row identity/order (month numbers, row count) is
// fixed here — changing the number of months is a separate, structural
// operation (setLedgerMonths below).
const editLedgerRows = async (req, res) => {
  const { ledger_id } = req.params;
  const { rows: editedRows, advance_payment: editedAdvance } = req.body;

  if (req.user?.role !== 'Super Admin') {
    return res.status(403).json({ success: false, message: 'Only Super Admin can edit the ledger.' });
  }
  if (editedRows !== undefined && (!Array.isArray(editedRows) || editedRows.length === 0)) {
    return res.status(400).json({ success: false, message: 'rows must be a non-empty array.' });
  }
  if (editedRows === undefined && !editedAdvance) {
    return res.status(400).json({ success: false, message: 'Provide rows and/or advance_payment to update.' });
  }

  try {
    const ledger = await prisma.installmentLedger.findUnique({
      where: { id: parseInt(ledger_id, 10) },
      include: { order: { select: { id: true, order_ref: true } } },
    });
    if (!ledger) {
      return res.status(404).json({ success: false, message: 'Ledger not found.' });
    }

    const allExistingRows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : [];
    // The advance payment (month 0) has its own separate "Advance Payment"
    // display, edited independently of the Installment Schedule table below
    // (editedAdvance, handled further down) — only compare/replace the
    // month>0 rows here.
    const advanceRow = allExistingRows.find((r) => Number(r.month) === 0) || null;
    const existingRows = allExistingRows.filter((r) => Number(r.month) !== 0);
    if (editedRows !== undefined && editedRows.length !== existingRows.length) {
      return res.status(400).json({
        success: false,
        message: 'Row count mismatch — use the "change total months" action to add or remove installments, not a direct row edit.',
      });
    }

    const changedMonths = [];
    const newInstallmentRows = editedRows === undefined ? existingRows : existingRows.map((existing, i) => {
      const edited = editedRows[i];
      if (Number(edited.month) !== Number(existing.month)) {
        throw Object.assign(new Error(`Row ${i} month mismatch (expected ${existing.month}, got ${edited.month}).`), { httpStatus: 400 });
      }

      const amount = parseFloat(edited.amount);
      const paidAmount = Math.max(0, parseFloat(edited.paid_amount) || 0);
      if (isNaN(amount) || amount < 0) {
        throw Object.assign(new Error(`Row for month ${existing.month} has an invalid amount.`), { httpStatus: 400 });
      }
      const status = paidAmount <= 0 ? 'pending' : (paidAmount >= amount ? 'paid' : 'partial');

      const oldPaidAmount = Math.max(0, parseFloat(existing.paid_amount) || 0);
      const paidAmountChanged = Math.abs(paidAmount - oldPaidAmount) > 0.01;
      if (paidAmountChanged) changedMonths.push(existing.month);

      const paymentMethod = edited.payment_method || existing.payment_method || null;
      const dueDate = edited.due_date || existing.due_date;

      const row = {
        ...existing,
        label: edited.label || existing.label,
        due_date: dueDate,
        amount,
        paid_amount: status === 'pending' ? 0 : paidAmount,
        status,
        payment_method: status === 'pending' ? null : paymentMethod,
        feedback: edited.feedback !== undefined ? edited.feedback : existing.feedback,
      };

      if (status === 'pending') {
        row.paid_at = null;
      } else if (paidAmountChanged || !existing.paid_at) {
        row.paid_at = now();
      }

      if (paidAmountChanged) {
        const history = Array.isArray(existing.payment_history) ? [...existing.payment_history] : [];
        history.push({
          amount: paidAmount - oldPaidAmount,
          date: now().toISOString(),
          method: paymentMethod || 'Manual correction',
          admin_edit: true,
          edited_by: req.user.id,
        });
        row.payment_history = history;
        row.collection_source = 'admin_edit';
      }

      return row;
    });

    let finalAdvanceRow = advanceRow;
    if (editedAdvance && advanceRow) {
      const amount = parseFloat(editedAdvance.amount);
      const paidAmount = Math.max(0, parseFloat(editedAdvance.paid_amount) || 0);
      if (isNaN(amount) || amount < 0) {
        throw Object.assign(new Error('Advance payment has an invalid amount.'), { httpStatus: 400 });
      }
      const status = paidAmount <= 0 ? 'pending' : (paidAmount >= amount ? 'paid' : 'partial');

      const oldPaidAmount = Math.max(0, parseFloat(advanceRow.paid_amount) || 0);
      const paidAmountChanged = Math.abs(paidAmount - oldPaidAmount) > 0.01;
      if (paidAmountChanged) changedMonths.push('advance');

      const paymentMethod = editedAdvance.payment_method || advanceRow.payment_method || null;

      finalAdvanceRow = {
        ...advanceRow,
        amount,
        paid_amount: status === 'pending' ? 0 : paidAmount,
        status,
        payment_method: status === 'pending' ? null : paymentMethod,
      };

      if (status === 'pending') {
        finalAdvanceRow.paid_at = null;
      } else if (paidAmountChanged || !advanceRow.paid_at) {
        finalAdvanceRow.paid_at = now();
      }

      if (paidAmountChanged) {
        const history = Array.isArray(advanceRow.payment_history) ? [...advanceRow.payment_history] : [];
        history.push({
          amount: paidAmount - oldPaidAmount,
          date: now().toISOString(),
          method: paymentMethod || 'Manual correction',
          admin_edit: true,
          edited_by: req.user.id,
        });
        finalAdvanceRow.payment_history = history;
        finalAdvanceRow.collection_source = 'admin_edit';
      }
    }

    const newRows = [...(finalAdvanceRow ? [finalAdvanceRow] : []), ...newInstallmentRows];

    await prisma.installmentLedger.update({
      where: { id: ledger.id },
      data: { ledger_rows: newRows, updated_at: now() },
    });

    await logAction(
      req,
      'LEDGER_EDITED',
      `Ledger for order ${ledger.order.order_ref} manually edited by ${req.user.full_name || req.user.username}.${changedMonths.length ? ` Paid amount changed on month(s): ${changedMonths.join(', ')}.` : ''}`,
      ledger.order.id,
      'Order',
    );

    const normalized = getNormalizedLedger(newRows);
    return res.json({ success: true, message: 'Ledger updated successfully', data: { ledger_rows: newRows, normalized } });
  } catch (error) {
    console.error('editLedgerRows error:', error);
    return res.status(error.httpStatus || 500).json({ success: false, message: error.httpStatus ? error.message : 'Internal server error' });
  }
};

// Change the total number of installment months — Super Admin only. Every
// already-paid or partially-paid month is left completely untouched; only
// the still-fully-pending tail is discarded and rebuilt, spreading whatever
// balance is currently outstanding evenly across the new number of pending
// months (the last one absorbing any rounding remainder). Arrears keep
// working automatically afterward — ledgerUtils.js's normalizeLedger
// recomputes them at read time from whatever amount/paid_amount/due_date/
// status values end up on the rows, same as any other ledger.
const setLedgerMonths = async (req, res) => {
  const { ledger_id } = req.params;
  const { months } = req.body;

  if (req.user?.role !== 'Super Admin') {
    return res.status(403).json({ success: false, message: 'Only Super Admin can change the installment plan.' });
  }
  const newMonths = parseInt(months, 10);
  if (!newMonths || newMonths < 1) {
    return res.status(400).json({ success: false, message: 'months must be a positive integer.' });
  }

  try {
    const ledger = await prisma.installmentLedger.findUnique({
      where: { id: parseInt(ledger_id, 10) },
      include: { order: { select: { id: true, order_ref: true } } },
    });
    if (!ledger) {
      return res.status(404).json({ success: false, message: 'Ledger not found.' });
    }

    const rows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : [];
    const advanceRow = rows.find((r) => Number(r.month) === 0) || null;
    const installmentRows = rows.filter((r) => Number(r.month) > 0).sort((a, b) => Number(a.month) - Number(b.month));

    // Highest month that is paid or partial — everything up to and
    // including it is protected from being touched.
    let keptThroughMonth = 0;
    for (const r of installmentRows) {
      if (r.status === 'paid' || r.status === 'partial') keptThroughMonth = Number(r.month);
    }

    if (newMonths < keptThroughMonth) {
      return res.status(400).json({
        success: false,
        message: `Cannot set total months below ${keptThroughMonth} — that many months are already paid or partially paid.`,
      });
    }

    const totalRemaining = installmentRows.reduce((sum, r) => sum + Math.max(0, (parseFloat(r.amount) || 0) - (parseFloat(r.paid_amount) || 0)), 0);
    const newPendingMonths = newMonths - keptThroughMonth;

    if (newPendingMonths === 0) {
      if (totalRemaining > 1) {
        return res.status(400).json({
          success: false,
          message: `Cannot set total months to ${newMonths} — that leaves an outstanding balance of ${totalRemaining} with no pending months left to collect it in.`,
        });
      }
    }

    const keptRows = installmentRows.filter((r) => Number(r.month) <= keptThroughMonth);
    const anchorRow = keptRows[keptRows.length - 1] || advanceRow;
    const anchorDate = anchorRow ? new Date(anchorRow.due_date) : now();

    const newPendingRows = [];
    if (newPendingMonths > 0) {
      const flatAmount = Math.floor((totalRemaining / newPendingMonths) * 100) / 100;
      const lastAmount = Math.round((totalRemaining - flatAmount * (newPendingMonths - 1)) * 100) / 100;
      for (let i = 0; i < newPendingMonths; i += 1) {
        const monthNumber = keptThroughMonth + i + 1;
        newPendingRows.push({
          month: monthNumber,
          label: `Month ${monthNumber}`,
          due_date: addMonthsToDate(anchorDate, i + 1),
          amount: i === newPendingMonths - 1 ? lastAmount : flatAmount,
          paid_amount: 0,
          status: 'pending',
          paid_at: null,
          payment_method: null,
        });
      }
    }

    const newRows = [...(advanceRow ? [advanceRow] : []), ...keptRows, ...newPendingRows];

    await prisma.installmentLedger.update({
      where: { id: ledger.id },
      data: { ledger_rows: newRows, updated_at: now() },
    });

    await logAction(
      req,
      'LEDGER_MONTHS_CHANGED',
      `Installment plan for order ${ledger.order.order_ref} changed to ${newMonths} total months by ${req.user.full_name || req.user.username} (${keptThroughMonth} already paid/partial, ${newPendingMonths} regenerated).`,
      ledger.order.id,
      'Order',
    );

    const normalized = getNormalizedLedger(newRows);
    return res.json({ success: true, message: 'Installment plan updated successfully', data: { ledger_rows: newRows, normalized } });
  } catch (error) {
    console.error('setLedgerMonths error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * Repairs a delivered order that has no installment ledger.
 *
 * This exists because delivery completion is deliberately non-atomic: the
 * order flips to "delivered", cash-in-hand is booked and the WATI message
 * goes out inside a transaction, then the ledger is written afterwards. If
 * that write fails (a `short_id` collision was the known culprit) the
 * delivery still stands and the customer ends up with a delivered order and
 * no installment schedule at all — invisible until recovery goes looking.
 *
 * The rebuild reuses the exact same row builder as the delivery flow and
 * anchors the schedule to the ORIGINAL delivery date, not today, so the
 * repaired ledger is what the delivery would have produced. It refuses to
 * touch an order that already has a ledger — overwriting one would wipe
 * recorded payments.
 */
const rebuildOrderLedger = async (req, res) => {
  if (req.user?.role !== 'Super Admin') {
    return res.status(403).json({ success: false, message: 'Only Super Admin can rebuild a ledger.' });
  }

  const orderId = parseInt(req.params.order_id, 10);
  if (!Number.isInteger(orderId)) {
    return res.status(400).json({ success: false, message: 'A valid order_id is required.' });
  }

  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        delivery: true,
        installment_ledger: { select: { id: true, short_id: true } },
        verification: { include: { purchaser: true } },
      },
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }
    if (order.installment_ledger) {
      return res.status(409).json({
        success: false,
        message: `Order ${order.order_ref} already has a ledger (${order.installment_ledger.short_id}). Use the ledger editor instead — rebuilding would discard recorded payments.`,
      });
    }
    if (!order.delivery) {
      return res.status(400).json({
        success: false,
        message: `Order ${order.order_ref} has no delivery record, so there is nothing to build a ledger from.`,
      });
    }

    const delivery = order.delivery;

    // Delivery.selected_plan is the plan as it stood at delivery time and is
    // what the original ledger would have been built from; the Order columns
    // are the fallback for deliveries saved without a plan snapshot.
    let planObj = delivery.selected_plan;
    if (typeof planObj === 'string') {
      try { planObj = JSON.parse(planObj); } catch { planObj = null; }
    }

    const monthlyAmount = planObj?.monthly_amount || planObj?.monthlyAmount || order.monthly_amount || 0;
    const totalMonths = planObj?.months || planObj?.duration || order.months || 0;
    const advanceAmount = planObj?.advance ?? planObj?.advance_amount ?? order.advance_amount ?? 0;

    if (!(totalMonths > 0 && monthlyAmount > 0)) {
      return res.status(400).json({
        success: false,
        message: `Order ${order.order_ref} has no usable installment plan (months=${totalMonths}, monthly=${monthlyAmount}). Fix the order's plan first.`,
      });
    }

    // Anchor to when the goods actually left, so month 1 falls where the
    // customer expects it rather than a month after the repair.
    const deliveryDate = delivery.end_time || delivery.updated_at || delivery.created_at || now();

    const ledgerRows = buildLedgerRows({
      advanceAmount,
      monthlyAmount,
      totalMonths,
      customLedger: null,
      startDate: deliveryDate,
      feedbackLabel: delivery.self_pickup ? 'Self Pickup at Branch' : 'Collected at Delivery',
    });

    const ledgerToken = jwt.sign(
      { order_id: order.id, delivery_id: delivery.id },
      LEDGER_TOKEN_SECRET,
      { expiresIn: '730d' }
    );

    const purchaser = order.verification?.purchaser;
    const mobile = purchaser?.telephone_number || order.whatsapp_number;

    // The ledger's short_id is set to the customer's real 1Bill/TPS consumer
    // number itself (not an IMEI/random short_id) — see the matching
    // deliveryCompletionService.js change — so the repaired ledger's URL
    // already is the customer's 1Bill ID. Generated fresh per retry so a
    // short_id collision also gets a freshly-deduped 1Bill number.
    let ledger = null;
    let consumerNo = null;
    for (let attempt = 0; attempt < 5 && !ledger; attempt += 1) {
      consumerNo = await generateConsumerNumber(delivery.product_imei, mobile);
      try {
        ledger = await prisma.installmentLedger.create({
          data: {
            order_id: order.id,
            delivery_id: delivery.id,
            token: ledgerToken,
            short_id: consumerNo,
            ledger_rows: ledgerRows,
            created_at: now(),
            updated_at: now(),
          },
        });
      } catch (createErr) {
        const isShortIdRace = createErr?.code === 'P2002'
          && (createErr.meta?.target || []).toString().includes('short_id');
        if (!isShortIdRace) throw createErr;
      }
    }
    if (!ledger) {
      return res.status(500).json({ success: false, message: 'Could not allocate a unique ledger short_id. Please retry.' });
    }

    // Consumer numbers are what the bill-payment gateways look the customer
    // up by, so a repaired ledger without them is still half-broken. Skipped
    // when the delivery already has some (a partial failure mid-way).
    let consumerNumbersCreated = 0;
    try {
      const existing = await prisma.consumerNumber.count({ where: { delivery_id: delivery.id } });
      if (existing === 0) {
        const firstInstallment = ledgerRows[1] || null;
        const dueDate = firstInstallment?.due_date ? new Date(firstInstallment.due_date) : now();
        const billingMonthStr = String(dueDate.getFullYear()).slice(-2) + String(dueDate.getMonth() + 1).padStart(2, '0');
        const base = {
          ledger_id: ledger.id,
          delivery_id: delivery.id,
          customer_name: purchaser?.name || order.customer_name || 'N/A',
          mobile_number: mobile || 'N/A',
          imei_serial: delivery.product_imei || null,
          amount_due: firstInstallment?.amount || 0,
          billing_month: billingMonthStr,
          due_date: dueDate,
          bill_status: 'U',
          created_at: now(),
          updated_at: now(),
        };
        // Reuse the same 1Bill number already saved as short_id above —
        // calling generateConsumerNumber again here would (correctly) dedupe
        // against itself and hand back a different number, splitting the
        // ledger's URL from its displayed 1Bill ID.
        const created = await prisma.consumerNumber.createMany({
          data: [
            { ...base, consumer_number: consumerNo },
            { ...base, consumer_number: await generateSmartPayConsumerNumber(delivery.product_imei, mobile) },
          ],
        });
        consumerNumbersCreated = created.count;
      }
    } catch (consumerErr) {
      // Non-fatal: the ledger itself is the thing the user came here for.
      console.error('rebuildOrderLedger: consumer number creation failed (non-fatal):', consumerErr);
    }

    await logAction(
      req,
      'LEDGER_REBUILT',
      `Missing installment ledger for order ${order.order_ref} rebuilt by ${req.user.full_name || req.user.username} ` +
      `(${totalMonths} months x ${monthlyAmount}, anchored to delivery date ${new Date(deliveryDate).toISOString().slice(0, 10)}, short_id ${ledger.short_id}).`,
      order.id,
      'Order',
    );

    return res.json({
      success: true,
      message: `Ledger rebuilt for order ${order.order_ref}.`,
      data: {
        ledger_id: ledger.id,
        short_id: ledger.short_id,
        months: totalMonths,
        consumer_numbers_created: consumerNumbersCreated,
        normalized: getNormalizedLedger(ledgerRows, advanceAmount),
      },
    });
  } catch (error) {
    console.error('rebuildOrderLedger error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  viewLedger,
  downloadLedgerPdf,
  generateInstallmentPaymentOtp,
  verifyInstallmentPaymentOtp,
  sendLedgerToCustomer,
  editLedgerRows,
  setLedgerMonths,
  rebuildOrderLedger
};