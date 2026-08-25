const prisma = require('../../lib/prisma');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const axios = require('axios');
const qrcode = require('qrcode');
const { saveOTP, verifyOTP } = require('../utils/otpUtils');
const { generateDqr } = require('../utils/smartPayGateway');
const { sendCustomerLedger, sendNextInstallmentReminder } = require('../services/watiService');
const { sendQistReceivingForPayment, sendPartialPaymentForRow } = require('../utils/qistReceivingUtils');
const { sendOtp: sendOTP } = require('../services/otpDispatcher');
const { updateCashRegister } = require('../utils/cashRegisterUtils');
const { getNormalizedLedger, normalizeLedger } = require('../utils/ledgerUtils');
const { logAction } = require('../utils/auditLogger');
const { sendAccountAwarenessForOrder } = require('../utils/accountAwarenessUtils');
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

const statusBadge = (status) => {
  const colors = {
    paid: '#22c55e',
    partial: '#3b82f6',
    pending: '#f59e0b',
    overdue: '#ef4444'
  };
  const color = colors[status?.toLowerCase()] || '#6b7280';
  return `<span style="background:${color};color:#fff;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;text-transform:capitalize;display:inline-block;">${status}</span>`;
};

// Masks a 13-digit CNIC as 42101-*******-1, keeping only the first block and last digit visible.
const maskCnic = (cnic) => {
  const digits = (cnic || '').replace(/\D/g, '');
  if (digits.length !== 13) return cnic || 'N/A';
  return `${digits.slice(0, 5)}-${'*'.repeat(7)}-${digits.slice(-1)}`;
};

const ACCOUNT_STATUS_STYLES = {
  new: { label: 'Active', color: '#15803d', bg: '#dcfce7' },
  in_progress: { label: 'Active', color: '#15803d', bg: '#dcfce7' },
  delivered: { label: 'Active', color: '#15803d', bg: '#dcfce7' },
  completed: { label: 'Completed', color: '#1d4ed8', bg: '#dbeafe' },
  cancelled: { label: 'Cancelled', color: '#b91c1c', bg: '#fee2e2' },
  defaulted: { label: 'Defaulted', color: '#b91c1c', bg: '#fee2e2' },
};

const accountStatusMeta = (status) => {
  const key = (status || '').toLowerCase();
  return ACCOUNT_STATUS_STYLES[key] || { label: (status || 'N/A').replace(/_/g, ' '), color: '#475569', bg: '#f1f5f9' };
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
        take: 1,
      },
    },
  });
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

  const deliveryDate = formatDate(delivery?.end_time || ledger.created_at);
  const accountOpenedDate = formatDate(order.created_at);
  const customerSinceDate = formatDate(order.customer?.created_at || order.created_at);

  // ── Use normalized ledger for consistent financial calculations ──
  const normalized = getNormalizedLedger(ledger.ledger_rows);
  const { advance_payment: advancePayment, installment_ledger: installmentRows, summary, rows: allRows } = normalized;

  const advanceAmount = advancePayment.amount;
  const totalAmount = summary.grandTotalDue;
  const totalPaidAmount = summary.grandTotalPaid;
  const remainingAmount = summary.grandTotalRemaining;
  const paidInstallmentCount = summary.paidInstallments;
  const overdueAmount = summary.totalArrears;

  const monthlyInstallment = installmentRows[0]?.dueAmount || order.monthly_amount || 0;

  const nextDueRow = installmentRows.find(r => r.status !== 'paid');
  const nextDueDate = nextDueRow ? formatDate(nextDueRow.dueDate) : 'N/A';

  const paidDates = allRows.filter(r => r.status === 'paid' && r.paid_at).map(r => new Date(r.paid_at));
  const lastPaymentDate = paidDates.length ? formatDate(new Date(Math.max(...paidDates))) : 'N/A';

  const statusMeta = accountStatusMeta(order.status);

  const outlet = order.outlet;
  const branchName = outlet?.name || 'N/A';
  const branchAddress = outlet?.address || 'N/A';
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

  let consumerNumber = ledger.consumer_numbers?.[0]?.consumer_number || order.consumer_numbers?.[0]?.consumer_number || null;
  if (!consumerNumber && order?.id) {
    consumerNumber = `1017100015${String(order.id).slice(-6).padStart(6, '0')}`;
  }

  const smartPayQr = order.smart_pay_qrs?.[0] || null;
  let qrImageSrc = smartPayQr?.qr_image_base64 || null;

  // 1. Try SmartPay Gateway API DQR generation to get the exact SmartPay QR image
  if (!qrImageSrc && consumerNumber) {
    try {
      const dqrRes = await generateDqr({
        consumerNumber,
        consumerDetail: customerName,
        amount: monthlyInstallment || 0,
        cellNo: phone || '',
        referenceInfo: `QIST-${order.id}-${Date.now()}`.substring(0, 30),
      });
      if (dqrRes?.success && dqrRes?.qrImageBase64) {
        qrImageSrc = dqrRes.qrImageBase64;
      }
    } catch (dqrErr) {
      console.error('[LedgerController] SmartPay generateDqr error:', dqrErr);
    }
  }

  // 2. High-density EMVCo 1Bill DQR Payload String fallback (matches Picture 1 matrix density)
  if (!qrImageSrc && consumerNumber) {
    try {
      const formattedAmount = parseFloat(monthlyInstallment || 0).toFixed(2);
      const emvCoPayload = `00020101021226580016A0000006770101110216${consumerNumber}5204599953035865405${formattedAmount}5802PK5911Qist Market6007Karachi6304`;
      qrImageSrc = await qrcode.toDataURL(emvCoPayload, {
        errorCorrectionLevel: 'H',
        margin: 2,
        width: 350,
      });
    } catch (qrErr) {
      console.error('qrcode.toDataURL fallback error:', qrErr);
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
    const priorInstallments = installmentRows.filter(r => r.monthNumber < row.monthNumber);
    const isNext = row.status === 'pending' && priorInstallments.every(r => r.status === 'paid');
    const displayStatus = isNext ? 'pending' : row.status;
    return {
      rowNum: String(idx + 1).padStart(2, '0'),
      isAdvance: false,
      isNext,
      rowClass: isNext ? 'current-month' : '',
      dueDateText: formatDate(row.dueDate),
      dueAmountText: formatPKR(row.dueAmount),
      arrearsText: row.arrears ? formatPKR(row.arrears) : null,
      paidText: row.paidAmount > 0 ? formatPKR(row.paidAmount) : '—',
      paymentDateText: row.paidAt ? formatDate(row.paidAt) : '—',
      paymentMethodText: row.paymentMethod || '—',
      statusHtml: statusBadge(displayStatus),
      extra: idx >= 6,
    };
  });

  const mobileLedgerRowsHtml = rowsMeta.map(r => `
        <tr class="${r.rowClass} ${r.extra ? 'row-extra' : ''}">
          <td>${r.rowNum}</td>
          <td>${r.dueDateText}</td>
          <td style="color:#16a34a;font-weight:700;">${r.paidText}</td>
          <td>${r.statusHtml}</td>
        </tr>`).join('');

  const desktopLedgerRowsHtml = rowsMeta.map(r => `
        <tr class="${r.rowClass}">
          <td>${r.rowNum}</td>
          <td>${r.dueDateText}</td>
          <td style="font-weight:700;">${r.dueAmountText}${r.arrearsText ? `<div style="color:#ef4444;font-size:0.65rem;font-weight:500;">Arrears: ${r.arrearsText}</div>` : ''}</td>
          <td style="color:#16a34a;">${r.paidText}</td>
          <td>${r.paymentDateText}</td>
          <td>${r.paymentMethodText}</td>
          <td style="color:#94a3b8;">—</td>
          <td>${r.statusHtml}</td>
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
      <div class="summary-item"><span class="info-label">Overdue Amount</span><span class="info-val" style="color:#dc2626;">${formatPKR(overdueAmount)}</span></div>
      <div class="summary-item"><span class="info-label">Next Due Date</span><span class="info-val">${nextDueDate}</span></div>`;

  const hirerDetailsRows = `
      <div class="info-row"><span class="info-label">Hirer Name</span><span class="info-val">${customerName}${grantorRelationLabel}</span></div>
      <div class="info-row"><span class="info-label">CNIC</span><span class="info-val">${cnicMasked}</span></div>
      <div class="info-row"><span class="info-label">Mobile Number</span><span class="info-val">${phone}</span></div>
      <div class="info-row"><span class="info-label">Address</span><span class="info-val">${address}</span></div>
      ${purchaserMapUrl ? `<a class="btn-outline" style="margin-top:6px;display:inline-block;text-align:center;" href="${purchaserMapUrl}" target="_blank" rel="noopener">📍 Verification Location</a>` : ''}`;

  const branchDetailsBlock = `
      <div class="info-row"><span class="info-label">Branch Name</span><span class="info-val">${branchName}</span></div>
      <div class="info-row"><span class="info-label">Address</span><span class="info-val">${branchAddress}</span></div>
      <div class="info-row"><span class="info-label">Phone</span><span class="info-val">${QIST_SUPPORT_PHONE}</span></div>
      ${mapsUrl ? `<a class="btn-outline" style="margin-top:10px;display:inline-block;text-align:center;" href="${mapsUrl}" target="_blank" rel="noopener">📍 View on Map</a>` : ''}`;

  const paymentBoxHtml = `
      <div class="section-title" style="color:#0f172a;">SCAN & PAY</div>
      ${consumerNumber ? `
      <div class="info-label" style="margin-top:4px;">Your 1Bill ID</div>
      <div class="bill-id-box">
        <span id="billId-${ledger.id}">${consumerNumber}</span>
        <button class="copy-btn no-print" onclick="navigator.clipboard.writeText('${consumerNumber}').then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500);})">Copy</button>
      </div>` : ''}
      <div class="qr-box">
        <img src="${qrImageSrc}" alt="Scan & Pay QR" />
        <p>Powered by <strong>1BILL</strong></p>
      </div>
      <div class="section-title" style="color:#0f172a;margin-top:20px;">PAYMENT METHODS</div>
      <ul class="payment-methods-list">
        <li><span class="pm-dot" style="background:#16a34a;"></span>1Bill</li>
        <li><span class="pm-dot" style="background:#0ea5e9;"></span>QR Payment</li>
      </ul>
      <button class="btn-primary no-print" style="width:100%;margin-top:14px;" disabled>Payment Karne ka Tareeqa</button>`;

  const noteBoxHtml = `
      <div class="note-box">
        <div class="info-label" style="color:#b45309;margin-bottom:8px;">⚠ IMPORTANT NOTE</div>
        <ul>
          <li>Sirf 1Bill ID aur QR par hi payment karein.</li>
          <li>Agar aap cash payment karte hain to receiving message zaroor check karein.</li>
          <li>Payment ka message na aaye to hamare bande ko payment bilkul bhi na dein.</li>
          <li>Apni payment sirf official 1Bill ID ya QR se hi karein.</li>
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
      <div class="cust-sub" style="margin-top:6px;">Next Due Date: <strong>${nextDueDate}</strong></div>
    </div>

    <div class="mobile-outstanding">
      <div class="amt">${formatPKR(remainingAmount)}</div>
      <div class="lbl">Total Outstanding</div>
    </div>
    <a class="btn-primary no-print" href="javascript:void(0)" onclick="showTab('payments')" style="display:block;text-align:center;margin-bottom:20px;">Pay Now</a>

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
      <div class="section-title">🧾 Installment / Payment Ledger</div>
      <div class="table-wrapper" style="box-shadow:none;">
        <table class="ledger-table mobile-ledger-table" id="mobileLedgerTable">
          <thead><tr><th>#</th><th>Due Date</th><th>Paid</th><th>Status</th></tr></thead>
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
        <div class="info-label" style="margin-top:6px;">Next Due Date: <strong>${nextDueDate}</strong></div>
        <a class="btn-primary no-print" href="javascript:void(0)" onclick="showTab('payments')" style="display:inline-block;margin-top:10px;">Pay Now</a>
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

        <div class="card tab-panel" data-tab="dashboard">
          <div class="section-title">📊 Account Summary</div>
          <div class="summary-bar">${accountSummaryRows}</div>
        </div>

        <div class="card tab-panel" data-tab="dashboard,ledger" style="padding:0;overflow:hidden;">
          <div style="padding:1.2rem 1.2rem 0;">
            <div class="section-title" style="margin-bottom:0;border-bottom:none;padding-bottom:0;">🧾 Installment / Payment Ledger</div>
          </div>
          <div class="table-wrapper" style="box-shadow:none;border-radius:0;margin:14px 0 0;">
            <table class="ledger-table">
              <thead><tr><th>#</th><th>Due Date</th><th>Installment</th><th>Paid Amount</th><th>Payment Date</th><th>Payment Method</th><th>Receipt No.</th><th>Status</th></tr></thead>
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
        ledger = await fetchLedger({ short_id: token });
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
    const ledger = await fetchLedger({ short_id: shortId });
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
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Error — QistMarket</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8fafc;margin:0;padding:16px;}
    .box{text-align:center;padding:32px 24px;background:#fff;border-radius:24px;box-shadow:0 10px 25px -5px rgba(0,0,0,0.05);max-width:90%;width:400px;}
    h1{color:#ef4444;font-size:22px;margin-bottom:12px;}p{color:#64748b;font-size:15px;line-height:1.5;}
    @media (max-width:480px){.box{padding:24px 20px;} h1{font-size:20px;}}
  </style></head>
  <body><div class="box"><h1>❌ Khed hai!</h1><p>${message}</p>
  <p style="margin-top:16px;font-size:13px;color:#94a3b8;">QistMarket Support</p></div></body></html>`;
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

    const customerName = order.verification?.purchaser?.name || order.customer_name;
    const paymentTxnId = `${order.order_ref}-M${month_number}-${Date.now().toString(36).toUpperCase()}`;
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
        representativeName: req.user?.full_name,
        representativeNumber: req.user?.phone,
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
        representativeName: req.user?.full_name,
        representativeNumber: req.user?.phone,
      }).catch(err => console.error('Wati Partial Payment Error:', err));
    }

    sendAccountAwarenessForOrder(order.id, phone, { itemName: order.product_name });

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

    // Send Customer Ledger
    const remainingBalance = getNormalizedLedger(rows).summary.grandTotalRemaining;

    const altPhone = order.verification?.purchaser?.alternate_phone_number;
    const targetPhones = [phone];
    if (altPhone && altPhone.trim() !== '') targetPhones.push(altPhone.trim());

    for (const targetPhone of targetPhones) {
        sendCustomerLedger(targetPhone, {
            customerName,
            orderRef: order.order_ref,
            itemName: order.product_name,
            remainingBalance,
            ledgerUrl
        }).catch(e => console.error('[WATI] Ledger send error on payment:', e));
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

module.exports = {
  viewLedger,
  downloadLedgerPdf,
  generateInstallmentPaymentOtp,
  verifyInstallmentPaymentOtp,
  sendLedgerToCustomer
};