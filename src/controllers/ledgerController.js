const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const prisma = new PrismaClient();

const LEDGER_TOKEN_SECRET = process.env.LEDGER_TOKEN_SECRET;

// ─── Helpers ────────────────────────────────────────────────────────────────

const formatPKR = (amount) =>
  `PKR ${Number(amount || 0).toLocaleString('en-PK')}`;

const formatDate = (d) => {
  if (!d) return 'N/A';
  const date = new Date(d);
  return date.toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' });
};

const statusBadge = (status) => {
  const colors = { paid: '#22c55e', pending: '#f59e0b', overdue: '#ef4444' };
  const color = colors[status] || '#6b7280';
  return `<span style="background:${color};color:#fff;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;text-transform:capitalize;">${status}</span>`;
};

// ─── GET /api/ledger/:token ──────────────────────────────────────────────────

const viewLedger = async (req, res) => {
  const { token } = req.params;

  try {
    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, LEDGER_TOKEN_SECRET);
    } catch (err) {
      return res.status(401).send(renderErrorPage('Link invalid ya expire ho gaya hai.'));
    }

    const { order_id } = decoded;

    // Fetch ledger
    const ledger = await prisma.installmentLedger.findUnique({
      where: { order_id: parseInt(order_id) },
      include: {
        order: {
          include: {
            verification: { include: { purchaser: true } },
          },
        },
        delivery: {
          select: {
            product_imei: true,
            selected_plan: true,
            end_time: true,
          },
        },
      },
    });

    if (!ledger) {
      return res.status(404).send(renderErrorPage('Ledger nahi mila. Meherbani karke support se rabta karen.'));
    }

    const order = ledger.order;
    const delivery = ledger.delivery;
    const purchaser = order.verification?.purchaser;
    const customerName = purchaser?.name || order.customer_name || 'Customer';
    const cnic = purchaser?.cnic_number || 'N/A';
    const phone = purchaser?.telephone_number || order.whatsapp_number || 'N/A';
    const address = purchaser?.present_address || order.address || 'N/A';

    const plan = delivery?.selected_plan
      ? (typeof delivery.selected_plan === 'string'
          ? JSON.parse(delivery.selected_plan)
          : delivery.selected_plan)
      : null;

    const productName = plan?.productName || plan?.product_name || order.product_name || 'N/A';
    const imei = delivery?.product_imei || order.imei_serial || 'N/A';
    const colorVariant = plan?.color
      ? `${plan.color}${plan.variant ? ' / ' + plan.variant : ''}`
      : (plan?.colorVariant || 'N/A');
    const advanceAmount = plan?.advance || plan?.advance_amount || plan?.advancePayment || order.advance_amount || 0;
    const deliveryDate = formatDate(delivery?.end_time || ledger.created_at);

    const rows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : [];
    const totalAmount = rows.reduce((s, r) => s + (r.amount || 0), 0);
    const paidAmount = rows.filter(r => r.status === 'paid').reduce((s, r) => s + (r.amount || 0), 0);
    const remainingAmount = totalAmount - paidAmount;

    const html = `<!DOCTYPE html>
<html lang="ur" dir="ltr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Installment Ledger — ${order.order_ref}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', sans-serif; background: #f8fafc; color: #1e293b; font-size: 14px; }
    .wrapper { max-width: 860px; margin: 0 auto; padding: 32px 20px; }

    /* Header */
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; padding-bottom: 20px; border-bottom: 3px solid #6366f1; }
    .logo { font-size: 26px; font-weight: 800; color: #6366f1; letter-spacing: -1px; }
    .logo span { color: #1e293b; }
    .header-right { text-align: right; }
    .header-right .ref { font-size: 13px; color: #64748b; margin-bottom: 4px; }
    .header-right .ref strong { color: #1e293b; }
    .badge { display: inline-block; background: #dcfce7; color: #16a34a; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }

    /* Cards row */
    .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 24px; }
    .card { background: #fff; border-radius: 12px; padding: 18px; border: 1px solid #e2e8f0; }
    .card-label { font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px; }
    .card-value { font-size: 20px; font-weight: 700; color: #1e293b; }
    .card-value.green { color: #16a34a; }
    .card-value.orange { color: #d97706; }

    /* Section */
    .section { background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 20px 22px; margin-bottom: 20px; }
    .section-title { font-size: 13px; font-weight: 700; color: #6366f1; text-transform: uppercase; letter-spacing: .6px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid #f1f5f9; }
    .info-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px 24px; }
    .info-row { display: flex; flex-direction: column; }
    .info-label { font-size: 11px; color: #94a3b8; font-weight: 600; text-transform: uppercase; margin-bottom: 3px; }
    .info-val { font-size: 14px; color: #1e293b; font-weight: 500; }

    /* Table */
    table { width: 100%; border-collapse: collapse; }
    thead tr { background: #6366f1; color: #fff; }
    thead th { padding: 11px 14px; text-align: left; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
    tbody tr { border-bottom: 1px solid #f1f5f9; }
    tbody tr:nth-child(even) { background: #fafafa; }
    tbody tr.current-month { background: #eff6ff; }
    tbody td { padding: 11px 14px; font-size: 13.5px; }
    tfoot tr { background: #f8fafc; font-weight: 700; }
    tfoot td { padding: 12px 14px; font-size: 14px; border-top: 2px solid #e2e8f0; }

    /* Footer */
    .footer { text-align: center; margin-top: 28px; font-size: 12px; color: #94a3b8; }
    .footer strong { color: #6366f1; }

    /* Print */
    @media print {
      body { background: #fff; }
      .wrapper { padding: 10px; }
      .no-print { display: none !important; }
    }

    /* Print btn */
    .print-btn { display: block; width: 100%; padding: 14px; background: linear-gradient(135deg, #6366f1, #818cf8); color: #fff; border: none; border-radius: 10px; font-size: 15px; font-weight: 700; cursor: pointer; margin-bottom: 24px; font-family: 'Inter', sans-serif; }
    .print-btn:hover { opacity: .9; }
  </style>
</head>
<body>
<div class="wrapper">

  <!-- Header -->
  <div class="header">
    <div class="logo">Qist<span>Market</span></div>
    <div class="header-right">
      <div class="ref">Order Ref: <strong>${order.order_ref}</strong></div>
      <div class="ref">Delivery Date: <strong>${deliveryDate}</strong></div>
      <div class="badge">✓ Delivered</div>
    </div>
  </div>

  <!-- Print Button -->
  <button class="print-btn no-print" onclick="window.print()">🖨️ PDF Save / Print Karen</button>

  <!-- Summary Cards -->
  <div class="cards">
    <div class="card">
      <div class="card-label">Total Amount</div>
      <div class="card-value">${formatPKR(totalAmount)}</div>
    </div>
    <div class="card">
      <div class="card-label">Amount Paid</div>
      <div class="card-value green">${formatPKR(paidAmount + Number(advanceAmount))}</div>
    </div>
    <div class="card">
      <div class="card-label">Remaining</div>
      <div class="card-value orange">${formatPKR(remainingAmount)}</div>
    </div>
  </div>

  <!-- Customer Info -->
  <div class="section">
    <div class="section-title">👤 Customer Details</div>
    <div class="info-grid">
      <div class="info-row"><span class="info-label">Customer Name</span><span class="info-val">${customerName}</span></div>
      <div class="info-row"><span class="info-label">CNIC</span><span class="info-val">${cnic}</span></div>
      <div class="info-row"><span class="info-label">Phone</span><span class="info-val">${phone}</span></div>
      <div class="info-row"><span class="info-label">Address</span><span class="info-val">${address}</span></div>
    </div>
  </div>

  <!-- Product Info -->
  <div class="section">
    <div class="section-title">📦 Product Details</div>
    <div class="info-grid">
      <div class="info-row"><span class="info-label">Product</span><span class="info-val">${productName}</span></div>
      <div class="info-row"><span class="info-label">IMEI / Serial</span><span class="info-val">${imei}</span></div>
      <div class="info-row"><span class="info-label">Color / Variant</span><span class="info-val">${colorVariant}</span></div>
      <div class="info-row"><span class="info-label">Advance Paid</span><span class="info-val">${formatPKR(advanceAmount)}</span></div>
    </div>
  </div>

  <!-- Ledger Table -->
  <div class="section">
    <div class="section-title">📋 Installment Ledger</div>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Mahina</th>
          <th>Due Date</th>
          <th>Amount</th>
          <th>Status</th>
          <th>Paid On</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row, i) => {
          const isNext = row.status === 'pending' && rows.slice(0, i).every(r => r.status === 'paid');
          return `<tr class="${isNext ? 'current-month' : ''}">
            <td>${row.month}</td>
            <td>Month ${row.month}${isNext ? ' ⬅ Next' : ''}</td>
            <td>${formatDate(row.due_date)}</td>
            <td>${formatPKR(row.amount)}</td>
            <td>${statusBadge(row.status)}</td>
            <td>${row.paid_at ? formatDate(row.paid_at) : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="3">Total Installments</td>
          <td>${formatPKR(totalAmount)}</td>
          <td colspan="2">Baqi: ${formatPKR(remainingAmount)}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <!-- Footer -->
  <div class="footer">
    <p>Yeh document <strong>QistMarket</strong> ki taraf se generate kiya gaya hai.</p>
    <p style="margin-top:6px;">Kisi bhi inquiry ke liye QistMarket support se rabta karen.</p>
    <p style="margin-top:6px;">Generated: ${new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}</p>
  </div>
</div>
<script>
  // Auto-open print dialog if ?print=1 is in URL
  const params = new URLSearchParams(window.location.search);
  if (params.get('print') === '1') {
    window.addEventListener('load', () => setTimeout(() => window.print(), 600));
  }
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (error) {
    console.error('[LedgerController] viewLedger error:', error);
    return res.status(500).send(renderErrorPage('Server error. Meherbani karke baad mein try karen.'));
  }
};

// ─── Error Page ─────────────────────────────────────────────────────────────

function renderErrorPage(message) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error — QistMarket</title>
  <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8fafc;margin:0;}
  .box{text-align:center;padding:40px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;}
  h1{color:#ef4444;font-size:22px;margin-bottom:12px;}p{color:#64748b;font-size:15px;}</style></head>
  <body><div class="box"><h1>❌ Khed hai!</h1><p>${message}</p>
  <p style="margin-top:16px;font-size:13px;color:#94a3b8;">QistMarket Support</p></div></body></html>`;
}

module.exports = { viewLedger };
