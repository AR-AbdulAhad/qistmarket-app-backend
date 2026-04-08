const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const prisma = new PrismaClient();
const logoDataURI = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTc0IiBoZWlnaHQ9IjMwIiB2aWV3Qm94PSIwIDAgMTc0IDMwIiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPg0KPHBhdGggb3BhY2l0eT0iMC4yIiBkPSJNMzAgMTVDMzAgMjMuMjg0MyAyMy4yODQzIDMwIDE1IDMwQzYuNzE1NzMgMzAgMCAyMy4yODQzIDAgMTVDMCA2LjcxNTczIDYuNzE1NzMgMCAxNSAwQzIzLjI4NDMgMCAzMCA2LjcxNTczIDMwIDE1Wk01LjgyMjA2IDE1QzUuODIyMDYgMjAuMDY4OCA5LjkzMTE2IDI0LjE3NzkgMTUgMjQuMTc3OUMyMC4wNjg4IDI0LjE3NzkgMjQuMTc3OSAyMC4wNjg4IDI0LjE3NzkgMTVDMjQuMTc3OSA5LjkzMTE2IDIwLjA2ODggNS44MjIwNiAxNSA1LjgyMjA2QzkuOTMxMTYgNS44MjIwNiA1LjgyMjA2IDkuOTMxMTYgNS44MjIwNiAxNVoiIGZpbGw9IiNEMUQ1REIiLz4NCjxwYXRoIGQ9Ik0yNi4wNzExIDEwLjE0NDdDMjcuNTQzNCA5LjQ5ODk1IDI5LjI5MTQgMTAuMTY4NiAyOS42NDEgMTEuNzM3OUMyOS4xNTEgMTQuMDI3MSAzMC4xMjAxIDE2LjQxOCAyOS41MzIzIDE4LjcxNjRDMjguNzAyNSAyMS45NjExIDI2LjgxMDcgMjQuODM0OCAyNC4xNTgzIDI2Ljg3OTZDMjEuNTA1OSAyOC45MjQ1IDE4LjI0NTQgMzAuMDIyOCAxNC44OTY0IDI5Ljk5OTZDMTEuNTQ3MyAyOS45NzY1IDguMzAyMzMgMjguODMzMiA1LjY3ODQxIDI2Ljc1MTlDMy4wNTQ1IDI0LjY3MDcgMS4yMDI1OSAyMS43NzExIDAuNDE3NzIxIDE4LjUxNTJDLTAuMzY3MTQzIDE1LjI1OTQgLTAuMDM5ODA4OSAxMS44MzQ1IDEuMzQ3NTcgOC43ODYyNEMyLjczNDk2IDUuNzM3OTkgNS4xMDI1NyAzLjI0MTcyIDguMDczMjMgMS42OTUxNEMxMC4xNzc1IDAuNTk5NjIgMTIuNDk4NiAwLjAyNTI1NjYgMTQuODQzOCAwLjAwMDgxNDQ1MkMxNi40NTE1IC0wLjAxNTk0MDMgMTcuNTAxNCAxLjUzMzY5IDE3LjIwNzggMy4xMTQzNkYzLjExNDM2QzE2LjkxNDIgNC42OTUwNCAxNS4zNzE2IDUuNjg5NzMgMTMuNzc4MiA1LjkwMzc2QzEyLjczMjEgNi4wNDQyNyAxMS43MTA5IDYuMzY1MTIgMTAuNzYxOCA2Ljg1OTI1QzguOTQ0MTMgNy44MDU1NSA3LjQ5NTQ3IDkuMzMyOTIgNi42NDY1OSAxMS4xOThDNS43OTc3IDEzLjA2MzEgNS41OTc0MSAxNS4xNTg3IDYuMDc3NjQgMTcuMTUwOEM2LjU1Nzg3IDE5LjE0MyA3LjY5MDk5IDIwLjkxNzEgOS4yOTY0NyAyMi4xOTA2QzEwLjkwMTkgMjMuNDY0IDEyLjg4NzQgMjQuMTYzNiAxNC45MzY2IDI0LjE3NzdDMTYuOTg1NyAyNC4xOTE5IDE4Ljk4MDcgMjMuNTE5OSAyMC42MDM2IDIyLjI2ODdDMjIuMjI2NSAyMS4wMTc2IDIzLjM4NDEgMTkuMjU5MyAyMy44OTE4IDE3LjI3MzlDMjQuMTU2OSAxNi4yMzczIDI0LjIzNjkgMTUuMTY5OCAyNC4xMzU2IDE0LjExOTJDMjMuOTgxMyAxMi41MTg5IDI0LjU5ODcgMTAuNzkwNCAyNi4wNzExIDEwLjE0NDdWMTAuMTQ0N1oiIGZpbGw9IiM1NzUwRjEiLz4NCjxwYXRoIGQ9Ik00OC4zMjg5IDI0LjY1NjVINDVWNS4zNDM0Nkg0OC4zNTU0TDU3LjQxNzQgMTkuMDI5MVY1LjM0MzQ2SDYwLjc0NjRWMjQuNjU2NUg1Ny40MTc0TDQ4LjMyODkgMTAuOTcwOVYyNC42NTY1WiIgZmlsbD0id2hpdGUiLz4NCjxwYXRoIGQ9Ik02OS44NTYzIDI1QzY1Ljk3MjYgMjUgNjMuMjUxMyAyMi4xNzMxIDYzLjI1MTMgMTguMTMwOEM2My4yNTEzIDE0LjAzNTcgNjUuOTE5NyAxMS4yMDg3IDY5Ljc1MDcgMTEuMjA4N0M3My42NjA4IDExLjIwODcgNzYuMTQ0MyAxMy44MjQzIDc2LjE0NDMgMTcuODkzVjE4Ljg3MDVMNjYuMzE2IDE4Ljg5N0M2Ni41NTM4IDIxLjE5NTUgNjcuNzY5MiAyMi4zNTggNjkuOTA5MiAyMi4zNThDNzEuNjc5MyAyMi4zNTggNzIuODQxOCAyMS42NzExIDczLjIxMTcgMjAuNDI5M0g3Ni4xOTcyQzc1LjY0MjMgMjMuMjgyNyA3My4yNjQ1IDI1IDY5Ljg1NjMgMjVaTTY5Ljc3NzEgMTMuODUwN0M2Ny44NzQ4IDEzLjg1MDcgNjYuNzEyNCAxNC44ODExIDY2LjM5NTMgMTYuODM2Mkg3Mi45NDc1QzcyLjk0NzUgMTUuMDM5NiA3MS43MDU3IDEzLjg1MDcgNjkuNzc3MSAxMy44NTA3WiIgZmlsbD0id2hpdGUiLz4NCjxwYXRoIGQ9Ik03OS44NzQzIDI0LjY1NjVINzYuMjAxOUw4MC42OTMzIDE4LjI2MjlMNzYuMjAxOSAxMS42MDVINzkuOTUzNkw4Mi44MzMzIDE2LjA0MzZMODUuNjA3NSAxMS42MDVIODkuMjI3TDg0Ljc4ODQgMTguMjFMODkuMDk0OSAyNC42NTY1SDg1LjM5NjFMODIuNjIyIDIwLjM1MDFMNzkuODc0MyAyNC42NTY1WiIgZmlsbD0id2hpdGUiLz4NCjxwYXRoIGQ9Ik05NS4wNTc4IDI0LjY1NjVIOTEuODM0NVYxNC4yOTk5SDg5LjA2MDRMOTAuNzg3MyAxMS42MDVIOTEuODM0NVY4LjMyODkzSDk1LjA1NzhWMTEuNjA1SDk3LjU5NDFWMTQuMjk5OUg5NS4wNTc4VjI0LjY1NjVaIiBmaWxsPSJ3aGl0ZSIvPg0KPHBhdGggZD0iTTEwMi43OTUgMjQuNjU2NUg5OS4yODA5TDEwNi4yNTYgNS4zNDM0NkgxMDkuNzE3TDExNi42OTIgMjQuNjU2NUgxMTMuMTI1TDEwOS41NjYgMjAuMTkxNUgxMDQuMzU0TDEwMi43OTUgMjQuNjU2NVpNMTA3LjU1IDExLjEwM0wxMDUuMzU3IDE3LjMzODJIMTEwLjU4OUwxMDguMzY5IDExLjEwM0MxMDguMjExIDEwLjYwMTEgMTA4LjAyNiAxMC4wMTk4IDEwNy45NzMgOS42MjM1MUMxMDcuODk0IDkuOTkzNCAxMDcuNzM1IDEwLjU3NDYgMTA3LjU1IDExLjEwM1oiIGZpbGw9IndoaXRlIi8+DQo8cGF0aCBkPSJNMTIyLjYxNSAyNUMxMTguODM3IDI1IDExNi40ODYgMjIuMjI1OSAxMTYuNDg2IDE4LjE4MzZDMTE2LjQ4NiAxNC4xMTQ5IDExOC44NjQgMTEuMjA4NyAxMjIuOCAxMS4yMDg3QzEyNC42MjMgMTEuMjA4NyAxMjYuMjM1IDExLjk3NDkgMTI3LjA1NCAxMy4yNjk1VjVIMTMwLjI1MVYyNC42NTY1SDEyNy4yOTJMMTI3LjA4IDIyLjYyMjJDMTI2LjI4OCAyNC4xMjgxIDEyNC41OTcgMjUgMTIyLjYxNSAyNVpNMTIzLjMyOSAyMi4wNDFDMTI1LjU3NCAyMi4wNDEgMTI3LjAyNyAyMC40MjkzIDEyNy4wMjcgMTguMDc3OUMxMjcuMDI3IDE1LjcyNjYgMTI1LjU3NCAxNC4wODg1IDEyMy4zMjkgMTQuMDg4NUMxMjEuMDgzIDE0LjA4ODUgMTE5LjcwOSAxNS43NTMgMTE5LjcwOSAxOC4wNzc5QzExOS43MDkgMjAuNDAyOSAxMjEuMDgzIDIyLjA0MSAxMjMuMzI5IDIyLjA0MVoiIGZpbGw9IndoaXRlIi8+DQo8cGF0aCBkPSJNMTM2LjA0IDI0LjY1NjVIMTMyLjgxN1YxMS42MDVIMTM1Ljc3NkwxMzYuMDQgMTMuMTM3NEMxMzYuNzAxIDEyLjA1NDIgMTM4LjAyMiAxMS4yMDg3IDEzOS44OTggMTEuMjA4N0MxNDEuODc5IDExLjIwODcgMTQzLjI1MyAxMi4xODYzIDE0My45NCAxMy42OTIyQzE0NC42IDEyLjE4NjMgMTQ2LjEzMyAxMS4yMDg3IDE0OC4xMTQgMTEuMjA4N0MxNTEuMjg1IDExLjIwODcgMTUzLjAyOCAxMy4xMTEgMTUzLjAyOCAxNi4xMjI5VjI0LjY1NjVIMTQ5LjgzMlYxNi45NjgzQzE0OS44MzIgMTUuMDkyNSAxNDguODI4IDE0LjExNDkgMTQ3LjI5NSAxNC4xMTQ5QzE0NS43MzYgMTQuMTE0OSAxNDQuNTQ4IDE1LjExODkgMTQ0LjU0OCAxNy4yNTg5VjI0LjY1NjVIMTQxLjMyNFYxNi45NDE5QzE0MS4zMjQgMTUuMTE4OSAxNDAuMzQ3IDE0LjE0MTMgMTM4LjgxNCAxNC4xNDEzQzEzNy4yODIgMTQuMTQxMyAxMzYuMDQgMTUuMTQ1MyAxMzYuMDQgMTcuMjU4OVYyNC42NTY1WiIgZmlsbD0id2hpdGUiLz4NCjxwYXRoIGQ9Ik0xNTcuMDEyIDguOTg5NDNDMTU1LjkwMiA4Ljk4OTQzIDE1NS4wMyA4LjExNzU3IDE1NS4wMyA3LjAzNDM1QzE1NS4wMyA1Ljk1MTEyIDE1NS45MDIgNS4xMDU2OCAxNTcuMDEyIDUuMTA1NjhDMTU4LjA2OCA1LjEwNTY4IDE1OC45NCA1Ljk1MTEyIDE1OC45NCA3LjAzNDM1QzE1OC45NCA4LjExNzU3IDE1OC4wNjggOC45ODk0MyAxNTcuMDEyIDguOTg5NDNaTTE1NS40IDI0LjY1NjVWMTEuNjA1SDE1OC42MjNWMjQuNjU2NUgxNTUuNFoiIGZpbGw9IndoaXRlIi8+DQo8cGF0aCBkPSJNMTY0LjM4NCAyNC42NTY1SDE2MS4xNjFWMTEuNjA1SDE2NC4xNDZMMTY0LjQxIDEzLjI5NTlDMTY1LjIzIDExLjk3NDkgMTY2LjgxNSAxMS4yMDg3IDE2OC41ODUgMTEuMjA4N0MxNzEuODYxIDExLjIwODcgMTczLjU1MiAxMy4yNDMxIDE3My41NTIgMTYuNjI0OFYyNC42NTY1SDE3MC4zMjlWMTcuMzkxQzE3MC4zMjkgMTUuMTk4MiAxNjkuMjQ1IDE0LjE0MTMgMTY3LjU4MSAxNC4xNDEzQzE2NS41OTkgMTQuMTQxMyAxNjQuMzg0IDE1LjUxNTIgMTY0LjM4NCAxNy42Mjg4VjI0LjY1NjVaIiBmaWxsPSJ3aGl0ZSIvPg0KPC9zdmc+DQo=';

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
  return `<span style="background:${color};color:#fff;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;text-transform:capitalize;display:inline-block;">${status}</span>`;
};

// ─── Shared: fetch ledger data from DB ──────────────────────────────────────

async function fetchLedger(where) {
  return prisma.installmentLedger.findUnique({
    where,
    include: {
      order: {
        include: {
          verification: { include: { purchaser: true } },
          cash_in_hand: { take: 1, orderBy: { created_at: 'desc' } },
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
}

// ─── Shared: build HTML from ledger record (RESPONSIVE VERSION) ───────────────────────────────────

function buildLedgerHtml(ledger, { showPrintBtn = false } = {}, stockItem = null) {
  const order = ledger.order;
  const delivery = ledger.delivery;
  const purchaser = order.verification?.purchaser;
  const customerName = purchaser?.name || 'Customer';
  const cnic = purchaser?.cnic_number || 'N/A';
  const phone = purchaser?.telephone_number || 'N/A';
  const address = purchaser?.present_address || 'N/A';

  const cashRecord = order.cash_in_hand?.[0];
  const plan = delivery?.selected_plan
    ? (typeof delivery.selected_plan === 'string'
      ? JSON.parse(delivery.selected_plan)
      : delivery.selected_plan)
    : null;

  const productName = cashRecord?.product_name
    || stockItem?.product_name
    || plan?.productName
    || plan?.product_name
    || order.product_name
    || 'N/A';

  const imei = cashRecord?.imei_serial || delivery?.product_imei || order.imei_serial || 'N/A';

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

  const advanceAmount = cashRecord?.amount
    || plan?.advance
    || plan?.advance_amount
    || plan?.advancePayment
    || plan?.advance_payment
    || order.advance_amount
    || 0;
  const deliveryDate = formatDate(delivery?.end_time || ledger.created_at);

  const rows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : [];
  const totalAmount = rows.reduce((s, r) => s + (r.amount || 0), 0);
  const paidAmount = rows.filter(r => r.status === 'paid').reduce((s, r) => s + (r.amount || 0), 0);
  const remainingAmount = totalAmount - paidAmount;

  const printBtnHtml = showPrintBtn
    ? `<button class="print-btn no-print" onclick="window.print()">🖨️ PDF Save / Print Karen</button>`
    : '';

  return `<!DOCTYPE html>
<html lang="ur" dir="ltr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>Installment Ledger — ${order.order_ref}</title>
  <style>
    /* RESET & FULLY RESPONSIVE STYLES */
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: system-ui, 'Segoe UI', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #f1f5f9;
      color: #0f172a;
      font-size: 14px;
      line-height: 1.4;
      padding: 16px;
    }

    @media (min-width: 768px) {
      body {
        padding: 24px;
      }
    }

    /* Main container */
    .ledger-wrapper {
      max-width: 1280px;
      margin: 0 auto;
      width: 100%;
    }

    /* Cards & containers */
    .card-bg {
      background: #ffffff;
      border-radius: 24px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05), 0 10px 20px -5px rgba(0,0,0,0.02);
    }

    /* Header - Fully responsive */
    .ledger-header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      margin-bottom: 24px;
      background: white;
      padding: 20px;
      border-radius: 28px;
    }

    @media (min-width: 640px) {
      .ledger-header {
        padding: 20px 28px;
      }
    }

    .brand-area {
      display: flex;
      align-items: center;
      gap: 14px;
      flex-wrap: wrap;
    }

    .logo-img {
      height: 40px;
      width: auto;
      display: block;
    }

    @media (min-width: 768px) {
      .logo-img {
        height: 44px;
      }
    }

    .title-tag h1 {
      font-size: 1.3rem;
      font-weight: 800;
      color: #0f172a;
    }

    @media (min-width: 640px) {
      .title-tag h1 {
        font-size: 1.6rem;
      }
    }

    .title-tag p {
      font-size: 0.7rem;
      color: #475569;
      margin-top: 2px;
    }

    .ref-badge-area {
      background: #f8fafc;
      padding: 10px 16px;
      border-radius: 36px;
      width: 100%;
    }

    @media (min-width: 640px) {
      .ref-badge-area {
        width: auto;
        text-align: right;
      }
    }

    .ref-badge-area .ref {
      font-size: 0.75rem;
      font-weight: 500;
      color: #334155;
    }

    .ref-badge-area .ref strong {
      color: #dc2626;
    }

    .delivery-badge {
      display: inline-block;
      background: #dcfce7;
      color: #15803d;
      font-size: 0.7rem;
      font-weight: 700;
      padding: 4px 12px;
      border-radius: 30px;
      margin-top: 6px;
    }

    /* Stats Grid - Responsive */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 14px;
      margin-bottom: 28px;
    }

    .stat-item {
      background: white;
      border-radius: 20px;
      padding: 1rem;
      text-align: center;
      border: 1px solid #eef2ff;
    }

    @media (min-width: 768px) {
      .stat-item {
        padding: 1.25rem;
      }
    }

    .stat-value {
      font-size: 1.3rem;
      font-weight: 800;
      color: #0f172a;
      word-break: break-word;
    }

    @media (min-width: 640px) {
      .stat-value {
        font-size: 1.6rem;
      }
    }

    @media (min-width: 1024px) {
      .stat-value {
        font-size: 1.8rem;
      }
    }

    .stat-label {
      font-size: 0.65rem;
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.5px;
      color: #5b6e8c;
      margin-top: 6px;
    }

    /* Action Bar */
    .action-bar {
      margin-bottom: 24px;
      display: flex;
      justify-content: flex-end;
    }

    .print-btn {
      background: #dc2626;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 60px;
      font-weight: 700;
      font-size: 0.9rem;
      cursor: pointer;
      width: 100%;
    }

    @media (min-width: 480px) {
      .print-btn {
        width: auto;
      }
    }

    /* Info Panels - 2 column responsive */
    .info-panels {
      display: grid;
      grid-template-columns: 1fr;
      gap: 20px;
      margin-bottom: 28px;
    }

    @media (min-width: 768px) {
      .info-panels {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    .info-card {
      background: white;
      border-radius: 24px;
      padding: 1.2rem;
    }

    @media (min-width: 640px) {
      .info-card {
        padding: 1.2rem 1.5rem;
      }
    }

    .section-title {
      font-size: 0.7rem;
      font-weight: 800;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: #dc2626;
      margin-bottom: 16px;
      border-bottom: 1.5px solid #f1f5f9;
      padding-bottom: 10px;
    }

    .info-grid-2col {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }

    @media (min-width: 480px) {
      .info-grid-2col {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    .info-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .info-label {
      font-size: 0.65rem;
      font-weight: 600;
      color: #6c86a3;
      text-transform: uppercase;
    }

    .info-val {
      font-size: 0.85rem;
      font-weight: 600;
      color: #1e293b;
      word-break: break-word;
    }

    /* Table - Horizontal Scroll on Mobile */
    .table-wrapper {
      overflow-x: auto;
      border-radius: 24px;
      background: white;
      margin-bottom: 24px;
      -webkit-overflow-scrolling: touch;
    }

    .ledger-table {
      width: 100%;
      border-collapse: collapse;
      min-width: 560px;
      font-size: 0.8rem;
    }

    @media (min-width: 768px) {
      .ledger-table {
        min-width: auto;
        font-size: 0.85rem;
      }
    }

    .ledger-table thead tr {
      background: #dc2626;
    }

    .ledger-table th {
      padding: 12px 10px;
      text-align: left;
      color: white;
      font-weight: 700;
      font-size: 0.7rem;
      text-transform: uppercase;
    }

    @media (min-width: 640px) {
      .ledger-table th {
        padding: 14px 12px;
        font-size: 0.75rem;
      }
    }

    .ledger-table td {
      padding: 10px 10px;
      border-bottom: 1px solid #f0f2f5;
    }

    @media (min-width: 640px) {
      .ledger-table td {
        padding: 12px 12px;
      }
    }

    .ledger-table tbody tr:nth-child(even) {
      background-color: #fefcfc;
    }

    .ledger-table tbody tr.current-month {
      background: #fff5f0;
    }

    tfoot tr {
      background: #f9fafb;
      font-weight: 800;
      border-top: 2px solid #e2e8f0;
    }

    tfoot td {
      padding: 12px 10px;
    }

    /* Footer */
    .footer-note {
      text-align: center;
      background: white;
      padding: 18px;
      border-radius: 24px;
      font-size: 0.7rem;
      color: #5b6e8c;
    }

    .footer-note strong {
      color: #dc2626;
    }

    /* Print Styles */
    @media print {
      body {
        background: white;
        padding: 0;
        margin: 0;
      }
      .ledger-wrapper {
        max-width: 100%;
        padding: 0.2in;
      }
      .action-bar,
      .print-btn,
      .no-print {
        display: none !important;
      }
      .ledger-header, .info-card, .stat-item, .table-wrapper, .footer-note {
        box-shadow: none;
        border: 1px solid #ddd;
        break-inside: avoid;
      }
      .ledger-table th {
        background: #333 !important;
        color: white !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }
  </style>
</head>
<body>
<div class="ledger-wrapper">

  <div class="ledger-header card-bg">
    <div class="brand-area">
      <img class="logo-img" src="${logoDataURI}" alt="QistMarket" />
      <div class="title-tag">
        <h1>Installment Ledger</h1>
        <p>Official Payment Record</p>
      </div>
    </div>
    <div class="ref-badge-area">
      <div class="ref">Order Ref: <strong>${order.order_ref}</strong></div>
      <div class="ref">Delivery Date: <strong>${deliveryDate}</strong></div>
      <div class="delivery-badge">✓ Delivered</div>
    </div>
  </div>

  <div class="action-bar no-print">
    ${printBtnHtml}
  </div>

  <div class="stats-grid">
    <div class="stat-item">
      <div class="stat-value">${formatPKR(totalAmount)}</div>
      <div class="stat-label">Total Amount</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${formatPKR(paidAmount + Number(advanceAmount))}</div>
      <div class="stat-label">Amount Paid</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${formatPKR(remainingAmount)}</div>
      <div class="stat-label">Remaining</div>
    </div>
  </div>

  <div class="info-panels">
    <div class="info-card">
      <div class="section-title">👤 Customer Details</div>
      <div class="info-grid-2col">
        <div class="info-row"><span class="info-label">Customer Name</span><span class="info-val">${customerName}</span></div>
        <div class="info-row"><span class="info-label">CNIC</span><span class="info-val">${cnic}</span></div>
        <div class="info-row"><span class="info-label">Phone</span><span class="info-val">${phone}</span></div>
        <div class="info-row"><span class="info-label">Address</span><span class="info-val">${address}</span></div>
      </div>
    </div>
    <div class="info-card">
      <div class="section-title">📦 Product Details</div>
      <div class="info-grid-2col">
        <div class="info-row"><span class="info-label">Product</span><span class="info-val">${productName}</span></div>
        <div class="info-row"><span class="info-label">IMEI / Serial</span><span class="info-val">${imei}</span></div>
        <div class="info-row"><span class="info-label">Color / Variant</span><span class="info-val">${colorVariant}</span></div>
        <div class="info-row"><span class="info-label">Stock Source</span><span class="info-val">${stockItem ? 'Outlet Inventory' : cashRecord ? 'Delivery Snapshot' : 'Order Record'}</span></div>
        <div class="info-row"><span class="info-label">Advance Paid</span><span class="info-val">${formatPKR(advanceAmount)}</span></div>
      </div>
    </div>
  </div>

  <div class="table-wrapper">
    <table class="ledger-table">
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
          <td colspan="3"><strong>Total Installments</strong></td>
          <td><strong>${formatPKR(totalAmount)}</strong></td>
          <td colspan="2"><strong>Remaining: ${formatPKR(remainingAmount)}</strong></td>
        </tr>
      </tfoot>
    </table>
  </div>

  <div class="footer-note">
    <p>Yeh document <strong>Qist Market</strong> ki taraf se generate kiya gaya hai.</p>
    <p style="margin-top:6px;">Kisi bhi inquiry ke liye QistMarket support se rabta karen.</p>
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
    let decoded;
    try {
      decoded = jwt.verify(token, LEDGER_TOKEN_SECRET);
    } catch (err) {
      return res.status(401).send(renderErrorPage('Link invalid ya expire ho gaya hai.'));
    }

    const ledger = await fetchLedger({ order_id: parseInt(decoded.order_id) });
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

module.exports = { viewLedger, downloadLedgerPdf };