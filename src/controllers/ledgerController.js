const prisma = require('../../lib/prisma');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const { saveOTP, verifyOTP } = require('../utils/otpUtils');
const { sendInstallmentLedger, sendInstallmentPaymentReceipt, sendPartialInstallmentPaymentReceipt, sendNextInstallmentReminder } = require('../services/watiService');
const { sendOtp: sendOTP } = require('../services/otpDispatcher');
const { updateCashRegister } = require('../utils/cashRegisterUtils');
const { getNormalizedLedger, normalizeLedger } = require('../utils/ledgerUtils');
const { logAction } = require('../utils/auditLogger');
const { sendAccountAwarenessForOrder } = require('../utils/accountAwarenessUtils');
const logoDataURI = '';

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

const QIST_SUPPORT_PHONE = '021-111-11-7747';

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
        },
      },
      consumer_numbers: {
        orderBy: { created_at: 'asc' },
        take: 1,
      },
    },
  });
}

// ─── Shared: build HTML from ledger record (RESPONSIVE VERSION) ───────────────────────────────────

function buildLedgerHtml(ledger, { showPrintBtn = false } = {}, stockItem = null) {
  const order = ledger.order;
  const delivery = ledger.delivery;
  const purchaser = order.verification?.purchaser;
  const grantors = order.verification?.grantors || [];
  const customerName = purchaser?.name || order.customer_name || 'Customer';
  const fatherHusbandName = purchaser?.father_husband_name || '';
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

  const monthlyInstallment = order.monthly_amount || installmentRows[0]?.dueAmount || 0;

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

  const consumerNumber = ledger.consumer_numbers?.[0]?.consumer_number || null;
  const smartPayQr = order.smart_pay_qrs?.[0] || null;
  const qrImageSrc = smartPayQr?.qr_image_base64 || null;

  const printBtnHtml = showPrintBtn
    ? `<button class="print-btn no-print" onclick="window.print()">🖨️ PDF Save / Print Karen</button>`
    : '';

  // ── Guarantor cards (real data from GrantorVerification, if any exist) ──
  const guarantorCardsHtml = grantors.length
    ? grantors.map((g, idx) => `
        <div class="guarantor-item">
          <div class="info-label" style="margin-bottom:6px;">Guarantor ${idx + 1}</div>
          <div class="info-val" style="margin-bottom:8px;">${g.name}</div>
          <div class="info-grid-2col">
            <div class="info-row"><span class="info-label">CNIC</span><span class="info-val">${maskCnic(g.cnic_number)}</span></div>
            <div class="info-row"><span class="info-label">Mobile</span><span class="info-val">${g.telephone_number || 'N/A'}</span></div>
          </div>
        </div>`).join('')
    : `<p style="font-size:0.8rem;color:#94a3b8;">Koi guarantor record maujood nahi.</p>`;

  // ── Ledger rows, computed once and rendered into both a compact (mobile) and full (desktop) table ──
  const rowsMeta = allRows.map((row, idx) => {
    const isAdvance = row.month === 0;
    const priorInstallments = installmentRows.filter(r => r.month < row.month);
    const isNext = !isAdvance && row.status === 'pending' && priorInstallments.every(r => r.status === 'paid');
    const displayStatus = isNext ? 'pending' : row.status;
    return {
      rowNum: String(idx + 1).padStart(2, '0'),
      isAdvance,
      isNext,
      rowClass: `${isAdvance ? 'advance-row' : ''} ${isNext ? 'current-month' : ''}`,
      dueDateText: isAdvance ? deliveryDate : formatDate(row.due_date),
      dueAmountText: formatPKR(row.dueAmount),
      arrearsText: row.arrears ? formatPKR(row.arrears) : null,
      paidText: row.paidAmount > 0 ? formatPKR(row.paidAmount) : '—',
      paymentDateText: row.paid_at ? formatDate(row.paid_at) : '—',
      paymentMethodText: row.payment_method || '—',
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

  const grantorRelationLabel = fatherHusbandName ? ` C/O ${fatherHusbandName}` : '';

  // ── Reusable content blocks (shared between mobile & desktop markup) ──

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
      <div class="summary-item"><span class="info-label">Total Outstanding</span><span class="info-val" style="color:#dc2626;">${formatPKR(remainingAmount)}</span></div>
      <div class="summary-item"><span class="info-label">Current Installment</span><span class="info-val" style="color:#2563eb;">${formatPKR(monthlyInstallment)}</span></div>
      <div class="summary-item"><span class="info-label">Overdue Amount</span><span class="info-val" style="color:#f59e0b;">${formatPKR(overdueAmount)}</span></div>
      <div class="summary-item"><span class="info-label">Next Due Date</span><span class="info-val">${nextDueDate}</span></div>`;

  const hirerDetailsRows = `
      <div class="info-row"><span class="info-label">Hirer Name</span><span class="info-val">${customerName}${grantorRelationLabel}</span></div>
      <div class="info-row"><span class="info-label">CNIC</span><span class="info-val">${cnicMasked}</span></div>
      <div class="info-row"><span class="info-label">Mobile Number</span><span class="info-val">${phone}</span></div>
      <div class="info-row"><span class="info-label">Address</span><span class="info-val">${address}</span></div>`;

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
      ${qrImageSrc ? `
      <div class="qr-box">
        <img src="${qrImageSrc}" alt="Scan & Pay QR" />
        <p>Powered by <strong>1BILL</strong></p>
      </div>` : `<p style="font-size:0.75rem;color:#94a3b8;margin-top:10px;">QR abhi generate nahi hui.</p>`}
      <div class="section-title" style="color:#0f172a;margin-top:20px;">PAYMENT METHODS</div>
      <ul class="payment-methods-list">
        <li><span class="pm-dot" style="background:#16a34a;"></span>1Bill</li>
        <li><span class="pm-dot" style="background:#334155;"></span>Bank / Online Payment</li>
        <li><span class="pm-dot" style="background:#0ea5e9;"></span>QR Payment</li>
        <li><span class="pm-dot" style="background:#22c55e;"></span>EasyPaisa</li>
        <li><span class="pm-dot" style="background:#dc2626;"></span>JazzCash</li>
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

  const helpBoxHtml = `
      <div class="section-title" style="color:#dc2626;">HELP / COMPLAINT</div>
      <p style="font-size:0.78rem;color:#64748b;margin-bottom:12px;">Agar aapko kisi qisam ki pareshani hai to humse rabta karein.</p>
      <button class="btn-primary no-print" style="width:100%;margin-bottom:8px;" disabled>Submit Complaint</button>
      <button class="btn-outline no-print" style="width:100%;" disabled>Check Complaint Status</button>`;

  const docsListHtml = `
      <div class="section-title" style="color:#0f172a;">IMPORTANT DOCUMENTS</div>
      <ul class="doc-list">
        <li>📄 Order Details</li>
        <li>📄 Invoice / Agreement</li>
        <li>📄 Terms & Conditions</li>
        <li>📄 Payment Receipts Guide</li>
      </ul>`;

  const quickLinksHtml = `
      <div class="section-title" style="color:#0f172a;">QUICK LINKS</div>
      <ul class="doc-list">
        <li>📞 Contact Branch</li>
        <li>📘 Payment Guide</li>
        <li>📃 Terms & Conditions</li>
        <li>🔒 Privacy Policy</li>
      </ul>`;

  const contactUsHtml = `
      <div class="section-title" style="color:#0f172a;">CONTACT US</div>
      <p style="font-size:0.8rem;color:#334155;line-height:1.7;">
        📞 ${QIST_SUPPORT_PHONE}<br/>
        📍 ${branchAddress}<br/>
        🕒 Mon - Sat (11:00 AM - 08:30 PM)
      </p>`;

  const socialIconsHtml = `
      <div class="section-title" style="color:#0f172a;">FOLLOW US</div>
      <div class="social-icons no-print">
        <a href="#" aria-label="Facebook">f</a>
        <a href="#" aria-label="Instagram">◎</a>
        <a href="#" aria-label="YouTube">▶</a>
        <a href="#" aria-label="TikTok">♪</a>
      </div>`;

  const topNavHtml = `
      <nav class="desktop-topnav no-print">
        <div class="brand-area">
          <img class="logo-img" src="${logoDataURI}" alt="QistMarket" />
        </div>
        <div class="nav-links">
          <span>🏠 Dashboard</span>
          <span class="active">📋 Ledger</span>
          <span>✉️ Payments</span>
          <span>ℹ️ Complaints</span>
          <span>📄 Documents</span>
          <span>🛟 Support</span>
        </div>
        <div class="nav-branch">
          <span class="info-label">Branch</span>
          <div class="info-val">${branchName}</div>
        </div>
      </nav>`;

  const bottomNavHtml = `
      <nav class="mobile-bottomnav no-print">
        <span>🏠<br/>Dashboard</span>
        <span class="active">📋<br/>Ledger</span>
        <span>✉️<br/>Payments</span>
        <span>☰<br/>More</span>
      </nav>`;

  return `<!DOCTYPE html>
<html lang="ur" dir="ltr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>Installment Ledger — ${order.order_ref}</title>
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
    .doc-list li { padding: 7px 0; font-size: 0.8rem; font-weight: 600; color: #64748b; }

    .social-icons { display: flex; gap: 10px; }
    .social-icons a {
      width: 34px; height: 34px; border-radius: 50%; background: #f1f5f9; color: #475569;
      display: flex; align-items: center; justify-content: center; text-decoration: none; font-weight: 800;
    }

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

    .footer-note { padding: 18px; text-align: center; font-size: 0.7rem; color: #5b6e8c; margin-top: 20px; }
    .footer-note strong { color: #dc2626; }

    /* ── Mobile view ── */
    .mobile-topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .mobile-topbar .logo-img { height: 34px; }
    .mobile-header-card { text-align: left; }
    .mobile-header-card .cust-name { font-size: 1.05rem; font-weight: 800; }
    .mobile-header-card .cust-sub { font-size: 0.72rem; color: #64748b; margin-top: 2px; }
    .mobile-outstanding { background: #dc2626; color: #fff; border-radius: 18px; padding: 16px; text-align: center; margin: 14px 0; }
    .mobile-outstanding .amt { font-size: 1.7rem; font-weight: 900; }
    .mobile-outstanding .lbl { font-size: 0.68rem; text-transform: uppercase; opacity: 0.85; }
    .mobile-bottomnav {
      position: fixed; bottom: 0; left: 0; right: 0; background: #fff; border-top: 1px solid #eef2f7;
      display: flex; justify-content: space-around; padding: 8px 0 10px; font-size: 0.62rem; font-weight: 700; color: #94a3b8; z-index: 20;
    }
    .mobile-bottomnav span { text-align: center; line-height: 1.5; }
    .mobile-bottomnav span.active { color: #dc2626; }

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
    @media (min-width: 900px) { .footer-cols { grid-template-columns: repeat(4, 1fr); } }

    /* Print */
    @media print {
      body { background: #fff; padding: 0; }
      .no-print, .mobile-bottomnav, .desktop-topnav { display: none !important; }
      .view-desktop { display: block !important; }
      .view-mobile { display: none !important; }
      .desktop-grid { grid-template-columns: 1fr !important; }
      .card, .info-card, .table-wrapper, .footer-note { box-shadow: none; border: 1px solid #ddd; break-inside: avoid; }
      .ledger-table th { background: #333 !important; color: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
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
    <a class="btn-primary no-print" href="#mobile-pay" style="display:block;text-align:center;margin-bottom:20px;">Pay Now</a>

    <div class="card">
      <div class="section-title">📦 Product Details</div>
      <div class="info-grid-2col">${productDetailsRows}</div>
    </div>

    <div class="card">
      <div class="section-title">🗂 Plan Details</div>
      <div class="info-grid-2col">${planDetailsRows}</div>
    </div>

    <div class="card">
      <div class="section-title">🧾 Installment / Payment Ledger</div>
      <div class="table-wrapper" style="box-shadow:none;">
        <table class="ledger-table mobile-ledger-table" id="mobileLedgerTable">
          <thead><tr><th>#</th><th>Due Date</th><th>Paid</th><th>Status</th></tr></thead>
          <tbody>${mobileLedgerRowsHtml}</tbody>
        </table>
      </div>
      ${rowsMeta.some(r => r.extra) ? `<button class="view-all-btn no-print" onclick="document.getElementById('mobileLedgerTable').classList.toggle('show-all'); this.textContent = this.textContent.indexOf('All') > -1 ? 'Hide Payments' : 'View All Payments';">View All Payments</button>` : ''}
    </div>

    ${noteBoxHtml}

    <div class="card" id="mobile-pay">${paymentBoxHtml}</div>

    <div class="card">${helpBoxHtml}</div>

    <div class="card">
      <div class="section-title">📍 Branch Details</div>
      <div class="info-grid-2col">${branchDetailsBlock}</div>
    </div>

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
        <a class="btn-primary no-print" href="#desktop-pay" style="display:inline-block;margin-top:10px;">Pay Now</a>
      </div>
    </div>

    <div class="desktop-grid">
      <div>
        <div class="card">
          <div class="desktop-2col">
            <div>
              <div class="section-title">📦 Product Details</div>
              <div class="info-grid-2col">${productDetailsRows}</div>
            </div>
            <div>
              <div class="section-title">🗂 Plan Details</div>
              <div class="info-grid-2col">${planDetailsRows}</div>
            </div>
          </div>
        </div>

        <div class="card">
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

        <div class="card">
          <div class="section-title">📊 Account Summary</div>
          <div class="summary-bar">${accountSummaryRows}</div>
        </div>

        <div class="card" style="padding:0;overflow:hidden;">
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
      </div>

      <div id="desktop-pay">
        <div class="card">${paymentBoxHtml}</div>
        ${noteBoxHtml}
        <div class="card">${helpBoxHtml}</div>
      </div>
    </div>

    <div class="card footer-cols">
      <div>${docsListHtml}</div>
      <div>${quickLinksHtml}</div>
      <div>${contactUsHtml}</div>
      <div>${socialIconsHtml}</div>
    </div>

    <div class="action-bar no-print" style="display:flex;justify-content:flex-end;margin-top:16px;">${printBtnHtml}</div>
  </div>

  <div class="footer-note">
    <p>Yeh document <strong>Qist Market</strong> ki taraf se generate kiya gaya hai.</p>
    <p style="margin-top:6px;">Generated: ${new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}</p>
  </div>
</div>
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
    const html = buildLedgerHtml(ledger, { showPrintBtn: true }, stockItem);
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
    const html = buildLedgerHtml(ledger, { showPrintBtn: false }, stockItem);

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
    if (totalPaid >= dueAmount) {
      sendInstallmentPaymentReceipt(phone, {
        customerName,
        amount: payingNow,
        productName: order.product_name,
        orderRef: order.order_ref,
        date: new Date().toLocaleDateString('en-PK')
      }).catch(err => console.error('Wati Receipt Error:', err));
    } else {
      sendPartialInstallmentPaymentReceipt(phone, {
        customerName,
        paidAmount: payingNow,
        remainingAmount: Math.max(0, dueAmount - totalPaid),
        productName: order.product_name,
        orderRef: order.order_ref,
        dueDate: new Date(rows[rowIndex].due_date || rows[rowIndex].dueDate).toLocaleDateString('en-PK')
      }).catch(err => console.error('Wati Partial Receipt Error:', err));
    }

    sendAccountAwarenessForOrder(order.id, phone, { itemName: order.product_name });

    // Send Next Month Reminder if exists
    const nextRow = rows[rowIndex + 1];
    const ledgerUrl = ledger.short_id ? `${ledger.short_id}` : null;
    
    if (nextRow) {
      sendNextInstallmentReminder(phone, {
        customerName,
        productName: order.product_name,
        monthlyAmount: nextRow.amount || nextRow.dueAmount,
        dueDate: new Date(nextRow.due_date || nextRow.dueDate).toLocaleDateString('en-PK'),
        ledgerUrl
      });
    }

    // Send Installment Ledger
    const totalRemain = rows.reduce((s, r) => s + (r.amount || 0), 0);
    let firstRowAmount = 0;
    let dueDateStr = 'N/A';
    if (rows.length > 1) {
      firstRowAmount = rows[1].amount || rows[1].dueAmount || 0;
      const firstRowDate = new Date(rows[1].due_date || rows[1].dueDate);
      if (!isNaN(firstRowDate.getTime())) {
          dueDateStr = firstRowDate.toLocaleDateString('en-PK');
      }
    }
    
    const altPhone = order.verification?.purchaser?.alternate_phone_number;
    const targetPhones = [phone];
    if (altPhone && altPhone.trim() !== '') targetPhones.push(altPhone.trim());
    
    for (const targetPhone of targetPhones) {
        sendInstallmentLedger(targetPhone, {
            customerName,
            productName: order.product_name,
            orderRef: order.order_ref,
            nextMonthLabel: 'Mahina 1',
            monthlyAmount: firstRowAmount,
            dueDate: dueDateStr,
            totalRemaining: totalRemain,
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
    const { installment_ledger: installmentRows } = normalized;

    // Use normalized rows for amount
    let firstRowAmount = 0;
    let dueDateStr = 'N/A';
    if (installmentRows && installmentRows.length > 0) {
        firstRowAmount = installmentRows[0].amount || installmentRows[0].dueAmount || 0;
        dueDateStr = formatDatePK(installmentRows[0].due_date || installmentRows[0].dueDate);
    }
    
    const rows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : [];
    const totalRemain = rows.reduce((s, r) => s + (r.amount || 0), 0);

    const ledgerUrl = `${shortId}`;

    const sendPromises = phonesToSend.map(phone => 
      sendInstallmentLedger(phone, {
        customerName: customerName,
        productName: order.product_name || 'N/A',
        orderRef: order.order_ref,
        nextMonthLabel: 'Mahina 1',
        monthlyAmount: firstRowAmount,
        dueDate: dueDateStr,
        totalRemaining: totalRemain,
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