const prisma = require('../../lib/prisma');
const { syncBlacklistStatus } = require('../utils/blacklistUtils');
const { getNormalizedLedger, computeDueAndCurrent } = require('../utils/ledgerUtils');

// Largest overdue gap among this order's unpaid installments, in whole days.
function computeDaysOverdue(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  let maxDays = 0;
  for (const row of list) {
    if ((row.status || '').toLowerCase() === 'paid') continue;
    const dueDate = row.dueDate ? new Date(row.dueDate) : null;
    if (!dueDate || isNaN(dueDate.getTime()) || dueDate > todayEnd) continue;
    const days = Math.floor((todayEnd - dueDate) / 86400000);
    if (days > maxDays) maxDays = days;
  }
  return maxDays;
}

const getCustomers = async (req, res) => {
  const {
    page = 1,
    limit = 10,
    search = '',
  } = req.query;

  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
  const skip = (pageNum - 1) * limitNum;
  const q = search.trim();

  try {
    // Run automatic blacklist sync
    await syncBlacklistStatus();

    // Fetch user with role and outlet
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { role: true }
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: { code: 401, message: 'User not found' },
      });
    }

    // Base where clause
    const baseWhere = { is_delivered: true };

    // Role-based filtering
    console.log(user.role.name)
    if (user.role.name === 'Sales Officer') {
      // CSR (Sales Officer) sees only orders created by them
      baseWhere.created_by_user_id = req.user.id;
    } else if (user.outlet_id) {
      // Brancher (Outlet user) sees only orders from their outlet
      baseWhere.outlet_id = req.user.outlet_id;
    }
    // For other roles (e.g., Super Admin), no additional filter, see all

    const orderWhere = {
      ...baseWhere,
      ...(q && {
        OR: [
          // PurchaserVerification fields
          { verification: { purchaser: { name: { contains: q } } } },
          { verification: { purchaser: { cnic_number: { contains: q } } } },
          { verification: { purchaser: { telephone_number: { contains: q } } } },
          // Order whatsapp fallback
          { whatsapp_number: { contains: q } },
          // Delivery product_imei
          { delivery: { product_imei: { contains: q } } },
          // CashInHand product_name, imei_serial
          { cash_in_hand: { some: { product_name: { contains: q } } } },
          { cash_in_hand: { some: { imei_serial: { contains: q } } } },
        ],
      }),
    };

    // Fetch all matching delivered orders (no skip/take here — we group by customer first)
    const orders = await prisma.order.findMany({
      where: orderWhere,
      include: {
        verification: {
          include: {
            purchaser: true,
            documents: {
              where: { document_type: 'photo', person_type: 'purchaser' },
              orderBy: { uploaded_at: 'desc' },
              take: 1,
            },
          },
        },
        delivery: {
          include: {
            installment_ledger: true,
          },
        },
        installment_ledger: true,
        cash_in_hand: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
      orderBy: [{ customer_name: 'asc' }, { created_at: 'desc' }],
    });

    // ── Pre-fetch Inventory details based on IMEI ──────────────────
    const allImeis = orders
      .map(o => o.cash_in_hand?.[0]?.imei_serial || o.delivery?.product_imei || o.imei_serial)
      .filter(Boolean);

    const inventories = await prisma.outletInventory.findMany({
      where: { imei_serial: { in: allImeis } },
      select: { imei_serial: true, product_name: true, color_variant: true }
    });

    const inventoryMap = new Map();
    for (const inv of inventories) {
      if (inv.imei_serial) {
        inventoryMap.set(inv.imei_serial, inv);
      }
    }

    // ── Group by order (1 order = 1 customer row) ────────────────────
    const customerMap = new Map();

    for (const order of orders) {
      const key = `order-${order.id}`;

      const purchaser = order.verification?.purchaser || null;
      const cashInHand = order.cash_in_hand?.[0] || null;
      const delivery = order.delivery;
      const installmentLedgerModel = delivery?.installment_ledger || null;
      const profilePhoto = order.verification?.documents?.[0]?.file_url || null;

      // ── Customer details: purchaser se, fallback Order ────────
      const customerName = purchaser?.name || order.customer_name;
      const fatherHusbandName = purchaser?.father_husband_name || null;
      const cnicNumber = purchaser?.cnic_number || null;
      const presentAddress = purchaser?.present_address || order.address || null;
      const permanentAddress = purchaser?.permanent_address || null;
      const telephoneNumber = purchaser?.telephone_number || order.whatsapp_number;
      const nearestLocation = purchaser?.nearest_location || null;

      if (!customerMap.has(key)) {
        customerMap.set(key, {
          customer: {
            name: customerName,
            father_husband_name: fatherHusbandName,
            cnic_number: cnicNumber,
            whatsapp_number: order.whatsapp_number,
            telephone_number: telephoneNumber,
            present_address: presentAddress,
            permanent_address: permanentAddress,
            nearest_location: nearestLocation,
            city: order.city,
            area: order.area,
            profile_photo: profilePhoto,
            created_at: order.created_at,
          },
          orders: [],
          ledgerSummary: {
            totalOrders: 0,
            totalAdvanceReceived: 0,
            totalPaid: 0,
            totalRemaining: 0,
          },
        });
      }

      const group = customerMap.get(key);

      // ── Delivery date ──────────────────────────────────────────
      const deliveryDate = delivery?.end_time || order.updated_at;

      // ── Product info: Fetch from Inventory via IMEI first ───────────────────────────
      const imeiSerial = cashInHand?.imei_serial || delivery?.product_imei || order.imei_serial || null;
      const invInfo = imeiSerial ? inventoryMap.get(imeiSerial) : null;

      const productName = invInfo?.product_name || cashInHand?.product_name || order.product_name;
      const colorVariant = invInfo?.color_variant || cashInHand?.color_variant || null;

      // ── Plan info: Delivery.selected_plan se ──────────────────
      let selectedPlan = delivery?.selected_plan || null;
      if (typeof selectedPlan === 'string') {
        try { selectedPlan = JSON.parse(selectedPlan); } catch { selectedPlan = null; }
      }

      // ── Use normalizeLedger for consistent financial calculations ──
      const ledgerModel = order.installment_ledger || order.delivery?.installment_ledger;
      const normalized = getNormalizedLedger(ledgerModel?.ledger_rows);
      const { advance_payment: advancePayment, installment_ledger: installmentLedger, summary } = normalized;

      const advAmountVal = advancePayment.amount || 0;
      const hasPaidAdvance = advancePayment.paid;
      const grandTotalPaid = summary.grandTotalPaid;
      const grandTotalRemaining = summary.grandTotalRemaining;
      const grandTotalDue = summary.grandTotalDue;

      const monthlyAmount = installmentLedger[0]?.dueAmount
        || Number(selectedPlan?.monthly_amount || selectedPlan?.monthlyAmount || 0);
      const totalMonths = installmentLedger.length
        || Number(selectedPlan?.months || selectedPlan?.totalMonths || 0);


      group.orders.push({
        order_id: order.id,
        order_ref: order.order_ref,
        token_number: order.token_number,
        status: order.status,
        is_delivered: true,
        delivery_date: deliveryDate ? deliveryDate : null,
        created_at: order.created_at,
        verification_status: order.verification?.status || null,

        product_details: {
          product_name: productName,
          imei_serial: imeiSerial,
          color_variant: colorVariant,
        },

        plan: {
          selected_plan: selectedPlan,
          advance_amount: advAmountVal,
          monthly_amount: monthlyAmount,
          months: totalMonths,
          total_plan_value: grandTotalDue,
        },

        ledger: {
          advance_payment: advancePayment,
          installment_ledger: installmentLedger,
          ledger_token: installmentLedgerModel?.short_id || null,
          summary: summary,
        },
      });

      // ── Customer ledger summary update ─────────────────────────
      group.ledgerSummary.totalOrders += 1;
      group.ledgerSummary.totalAdvanceReceived += advAmountVal;
      group.ledgerSummary.totalPaid += grandTotalPaid;
      group.ledgerSummary.totalRemaining += grandTotalRemaining;
    }

    // ── Sort customers alphabetically ──────────────────────────
    let allCustomers = Array.from(customerMap.values()).sort((a, b) =>
      a.customer.name.localeCompare(b.customer.name)
    );

    // DB filter already handles all search cases — no post-group filter needed

    // ── Pagination on grouped customers ───────────────────────
    const totalCustomers = allCustomers.length;
    const totalPages = Math.ceil(totalCustomers / limitNum);
    const paginatedCustomers = allCustomers.slice(skip, skip + limitNum);

    return res.status(200).json({
      success: true,
      data: {
        customers: paginatedCustomers,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalCustomers,
          totalPages,
          hasNext: pageNum < totalPages,
          hasPrev: pageNum > 1,
        },
        totalOrders: orders.length,
      },
    });
  } catch (error) {
    console.error('Error in getCustomers:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const getBlacklistedCustomers = async (req, res) => {
  try {
    // Run automatic blacklist sync
    await syncBlacklistStatus();

    const today = new Date();
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(today.getDate() - 90);

    const orders = await prisma.order.findMany({
      where: {
        verification: {
          OR: [
            { purchaser: { is_blacklisted: true } },
            { grantors: { some: { is_blacklisted: true } } },
          ],
        },
      },
      include: {
        verification: {
          include: {
            purchaser: true,
            grantors: true,
            documents: {
              orderBy: { uploaded_at: 'desc' },
            },
          },
        },
        delivery: {
          include: {
            installment_ledger: true,
          },
        },
        installment_ledger: true,
        cash_in_hand: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
        recovery_officer: {
          select: { id: true, full_name: true },
        },
      },
    });

    // ── Pre-fetch Inventory details based on IMEI (Shared logic with getCustomers) ──
    const allImeis = orders
      .map(o => o.cash_in_hand?.[0]?.imei_serial || o.delivery?.product_imei || o.imei_serial)
      .filter(Boolean);

    const inventories = await prisma.outletInventory.findMany({
      where: { imei_serial: { in: allImeis } },
      select: { imei_serial: true, product_name: true, color_variant: true }
    });

    const inventoryMap = new Map();
    for (const inv of inventories) {
      if (inv.imei_serial) inventoryMap.set(inv.imei_serial, inv);
    }

    // ── Filter Blacklisted Orders ──────────────────────────────
    const blacklistedOrders = orders; // Already filtered via DB query

    // ── Group by order (1 order = 1 row) (Shared logic with getCustomers) ────────────────────
    const customerMap = new Map();

    for (const order of blacklistedOrders) {
      const key = `order-${order.id}`;

      const purchaser = order.verification?.purchaser || null;
      const cashInHand = order.cash_in_hand?.[0] || null;
      const delivery = order.delivery;
      const installmentLedgerModel = delivery?.installment_ledger || null;
      const profilePhoto = order.verification?.documents?.[0]?.file_url || null;

      const customerName = purchaser?.name || order.customer_name;
      const telephoneNumber = purchaser?.telephone_number || order.whatsapp_number;
      const hasBlacklistedGrantor = order.verification?.grantors?.some((g) => g.is_blacklisted);
      const isAccountBlacklisted = purchaser?.is_blacklisted || hasBlacklistedGrantor || false;

      // Which party on this order triggered the blacklist — drives the "Customer / Guarantor / G2" filter.
      let blacklistedRole = 'Customer';
      if (!purchaser?.is_blacklisted && hasBlacklistedGrantor) {
        const blacklistedGrantor = order.verification?.grantors?.find((g) => g.is_blacklisted);
        blacklistedRole = blacklistedGrantor?.grantor_number === 2 ? 'G2' : 'Guarantor';
      }

      if (!customerMap.has(key)) {
        customerMap.set(key, {
          customer: {
            name: customerName,
            father_husband_name: purchaser?.father_husband_name || null,
            cnic_number: purchaser?.cnic_number || null,
            whatsapp_number: order.whatsapp_number,
            telephone_number: telephoneNumber,
            present_address: purchaser?.present_address || order.address || null,
            permanent_address: purchaser?.permanent_address || null,
            nearest_location: purchaser?.nearest_location || null,
            city: order.city,
            area: order.area,
            profile_photo: profilePhoto,
            is_blacklisted: isAccountBlacklisted, // Marker for UI
            created_at: order.created_at,
            blacklisted_role: blacklistedRole,
            recovery_officer_name: order.recovery_officer?.full_name || null,
          },
          orders: [],
          ledgerSummary: {
            totalOrders: 0,
            totalAdvanceReceived: 0,
            totalPaid: 0,
            totalRemaining: 0,
            totalDue: 0,
            totalCurrent: 0,
            daysOverdue: 0,
          },
        });
      }

      const group = customerMap.get(key);

      const imeiSerial = cashInHand?.imei_serial || delivery?.product_imei || order.imei_serial || null;
      const invInfo = imeiSerial ? inventoryMap.get(imeiSerial) : null;

      const productName = invInfo?.product_name || cashInHand?.product_name || order.product_name;
      const colorVariant = invInfo?.color_variant || cashInHand?.color_variant || null;

      const normalized = getNormalizedLedger(installmentLedgerModel?.ledger_rows);
      const { advance_payment: advancePayment, installment_ledger: installmentLedger, summary } = normalized;

      const advanceAmount = advancePayment.amount || 0;
      const hasPaidAdvance = advancePayment.paid;
      const grandTotalPaid = summary.grandTotalPaid;
      const grandTotalRemaining = summary.grandTotalRemaining;
      const grandTotalDue = summary.grandTotalDue;

      group.orders.push({
        order_id: order.id,
        order_ref: order.order_ref,
        status: order.status,
        customer_name: order.customer_name, // Added for modal fallback
        verification: order.verification,   // CRITICAL: Added for the CustomerProfileModal
        product_details: {
          product_name: productName,
          imei_serial: imeiSerial,
          color_variant: colorVariant,
        },
        ledger: {
          summary: summary,
          installment_ledger: installmentLedger,
        },
      });

      const { due: orderDue, current: orderCurrent } = computeDueAndCurrent(installmentLedger);
      const orderDaysOverdue = computeDaysOverdue(installmentLedger);

      group.ledgerSummary.totalOrders += 1;
      group.ledgerSummary.totalAdvanceReceived += advanceAmount;
      group.ledgerSummary.totalPaid += grandTotalPaid;
      group.ledgerSummary.totalRemaining += grandTotalRemaining;
      group.ledgerSummary.totalDue += orderDue;
      group.ledgerSummary.totalCurrent += orderCurrent;
      group.ledgerSummary.daysOverdue = Math.max(group.ledgerSummary.daysOverdue, orderDaysOverdue);
    }

    const allBlacklisted = Array.from(customerMap.values()).sort((a, b) =>
      a.customer.name.localeCompare(b.customer.name)
    );

    // Attach manual blacklist reasons, blacklist date, and pending-whitelist status
    for (const c of allBlacklisted) {
      c.customer.blacklist_reason = 'Auto-flagged (90+ days delinquency)';
      c.customer.blacklist_date = null;
      c.customer.blacklist_status = 'Blacklisted';
    }
    const cnics = allBlacklisted.map(c => c.customer.cnic_number).filter(Boolean);
    if (cnics.length > 0) {
      const actions = await prisma.blacklistAction.findMany({
        where: { cnic: { in: cnics } },
        orderBy: { created_at: 'desc' }
      });

      // Latest "blacklist" action per cnic — drives reason + blacklist date.
      const blacklistActionMap = new Map();
      // Latest action of any kind per cnic — a pending whitelist request overrides the "Blacklisted" status.
      const latestActionMap = new Map();
      for (const a of actions) {
        if (!latestActionMap.has(a.cnic)) latestActionMap.set(a.cnic, a);
        if (a.action === 'blacklist' && !blacklistActionMap.has(a.cnic)) blacklistActionMap.set(a.cnic, a);
      }

      for (const c of allBlacklisted) {
        const cnic = c.customer.cnic_number;
        const blacklistAction = cnic ? blacklistActionMap.get(cnic) : null;
        const latestAction = cnic ? latestActionMap.get(cnic) : null;

        c.customer.blacklist_reason = blacklistAction
          ? (blacklistAction.reason || 'Manual blacklist (No reason provided)')
          : 'Auto-flagged (90+ days delinquency)';
        c.customer.blacklist_date = blacklistAction?.created_at || null;
        c.customer.blacklist_status = (latestAction?.action === 'whitelist' && latestAction.status === 'pending')
          ? 'Pending Whitelist'
          : 'Blacklisted';
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        customers: allBlacklisted,
        total: allBlacklisted.length,
        totalDueAmount: allBlacklisted.reduce((s, c) => s + (c.ledgerSummary.totalDue || 0), 0),
        totalCurrentAmount: allBlacklisted.reduce((s, c) => s + (c.ledgerSummary.totalCurrent || 0), 0),
      },
    });
  } catch (error) {
    console.error('Error in getBlacklistedCustomers:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getClearedCustomers = async (req, res) => {
  try {
    // Base where clause
    const baseWhere = { is_delivered: true };


    // Fetch all delivered orders
    const orders = await prisma.order.findMany({
      where: baseWhere,
      include: {
        verification: {
          include: {
            purchaser: true,
            grantors: true,
            documents: {
              orderBy: { uploaded_at: 'desc' },
            },
          },
        },
        delivery: {
          include: {
            installment_ledger: true,
          },
        },
        cash_in_hand: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
    });

    // Fetch returned orders that were NOT blacklisted on return — these are
    // also "cleared" (account settled via return rather than full payment),
    // but their Delivery/InstallmentLedger rows were deleted at return time,
    // so their ledger snapshot only survives in archived_deliveries.
    const returnedOrdersRaw = await prisma.order.findMany({
      where: { status: 'Returned' },
      include: {
        customer: { select: { is_blacklisted: true } },
        verification: {
          include: {
            purchaser: true,
            grantors: true,
            documents: {
              orderBy: { uploaded_at: 'desc' },
            },
          },
        },
        archived_deliveries: {
          orderBy: { archived_at: 'desc' },
          take: 1,
        },
      },
    });

    const returnedOrders = returnedOrdersRaw.filter(order => !(
      order.customer?.is_blacklisted ||
      order.verification?.purchaser?.is_blacklisted ||
      order.verification?.grantors?.some(g => g.is_blacklisted)
    ));

    const allImeis = orders
      .map(o => o.cash_in_hand?.[0]?.imei_serial || o.delivery?.product_imei || o.imei_serial)
      .filter(Boolean);

    const inventories = await prisma.outletInventory.findMany({
      where: { imei_serial: { in: allImeis } },
      select: { imei_serial: true, product_name: true, color_variant: true }
    });

    const inventoryMap = new Map();
    for (const inv of inventories) {
      if (inv.imei_serial) inventoryMap.set(inv.imei_serial, inv);
    }

    // ── Filter Cleared Orders (Fully Paid) ──────────────────────────────
    const clearedOrders = orders.filter(order => {
      const ledgerModel = order.delivery?.installment_ledger;
      if (!ledgerModel || !ledgerModel.ledger_rows) return false;

      let rows = [];
      try {
        rows = Array.isArray(ledgerModel.ledger_rows)
          ? ledgerModel.ledger_rows
          : JSON.parse(ledgerModel.ledger_rows);
      } catch (e) { return false; }

      if (!Array.isArray(rows)) return false;

      const installments = rows.filter(r => r.month > 0);
      if (installments.length === 0) return false;

      // Condition: ALL installments must be 'paid'
      const pendingCount = installments.filter(r => (r.status !== 'paid' && r.status !== 'Paid')).length;

      // Also check if Month 0 (Advance) was paid
      const advanceRow = rows.find(r => r.month === 0);
      const isAdvancePaid = advanceRow ? (advanceRow.status === 'paid' || advanceRow.status === 'Paid') : true;

      return pendingCount === 0 && isAdvancePaid;
    });

    // ── Group by order (1 order = 1 row) ────────────────────
    const customerMap = new Map();

    for (const order of clearedOrders) {
      const key = `order-${order.id}`;

      const purchaser = order.verification?.purchaser || null;
      const cashInHand = order.cash_in_hand?.[0] || null;
      const delivery = order.delivery;
      const installmentLedgerModel = delivery?.installment_ledger || null;
      const profilePhoto = order.verification?.documents?.[0]?.file_url || null;

      const customerName = purchaser?.name || order.customer_name;
      const telephoneNumber = purchaser?.telephone_number || order.whatsapp_number;

      if (!customerMap.has(key)) {
        customerMap.set(key, {
          customer: {
            name: customerName,
            father_husband_name: purchaser?.father_husband_name || null,
            cnic_number: purchaser?.cnic_number || null,
            whatsapp_number: order.whatsapp_number,
            telephone_number: telephoneNumber,
            present_address: purchaser?.present_address || order.address || null,
            permanent_address: purchaser?.permanent_address || null,
            nearest_location: purchaser?.nearest_location || null,
            city: order.city,
            area: order.area,
            profile_photo: profilePhoto,
            is_cleared: true,
            clear_reason: 'completed',
            created_at: order.created_at,
            cleared_at: order.updated_at,
          },
          orders: [],
          ledgerSummary: {
            totalOrders: 0,
            totalAdvanceReceived: 0,
            totalPaid: 0,
            totalRemaining: 0,
          },
        });
      }

      const group = customerMap.get(key);

      const imeiSerial = cashInHand?.imei_serial || delivery?.product_imei || order.imei_serial || null;
      const invInfo = imeiSerial ? inventoryMap.get(imeiSerial) : null;

      const productName = invInfo?.product_name || cashInHand?.product_name || order.product_name;
      const colorVariant = invInfo?.color_variant || cashInHand?.color_variant || null;

      const normalized = getNormalizedLedger(installmentLedgerModel?.ledger_rows);
      const { advance_payment: advancePayment, installment_ledger: installmentLedger, summary } = normalized;

      const advanceAmount = advancePayment.amount || 0;
      const hasPaidAdvance = advancePayment.paid;
      const grandTotalPaid = summary.grandTotalPaid;
      const grandTotalRemaining = summary.grandTotalRemaining;

      group.orders.push({
        order_id: order.id,
        order_ref: order.order_ref,
        status: order.status,
        clear_reason: 'completed',
        customer_name: order.customer_name,
        verification: order.verification,
        product_details: {
          product_name: productName,
          imei_serial: imeiSerial,
          color_variant: colorVariant,
        },
        ledger: {
          summary: summary,
          installment_ledger: installmentLedger,
        },
      });

      group.ledgerSummary.totalOrders += 1;
      group.ledgerSummary.totalAdvanceReceived += advanceAmount;
      group.ledgerSummary.totalPaid += grandTotalPaid;
      group.ledgerSummary.totalRemaining += grandTotalRemaining;
    }

    // ── Group returned (non-blacklisted) orders — cleared via return ────
    for (const order of returnedOrders) {
      const key = `order-${order.id}`;

      const purchaser = order.verification?.purchaser || null;
      const archivedDelivery = order.archived_deliveries?.[0] || null;
      const profilePhoto = order.verification?.documents?.[0]?.file_url || null;

      const customerName = purchaser?.name || order.customer_name;
      const telephoneNumber = purchaser?.telephone_number || order.whatsapp_number;

      let archivedPlan = archivedDelivery?.selected_plan || null;
      if (typeof archivedPlan === 'string') {
        try { archivedPlan = JSON.parse(archivedPlan); } catch (e) { archivedPlan = null; }
      }

      if (!customerMap.has(key)) {
        customerMap.set(key, {
          customer: {
            name: customerName,
            father_husband_name: purchaser?.father_husband_name || null,
            cnic_number: purchaser?.cnic_number || null,
            whatsapp_number: order.whatsapp_number,
            telephone_number: telephoneNumber,
            present_address: purchaser?.present_address || order.address || null,
            permanent_address: purchaser?.permanent_address || null,
            nearest_location: purchaser?.nearest_location || null,
            city: order.city,
            area: order.area,
            profile_photo: profilePhoto,
            is_cleared: true,
            clear_reason: 'returned',
            created_at: order.created_at,
            cleared_at: order.updated_at,
          },
          orders: [],
          ledgerSummary: {
            totalOrders: 0,
            totalAdvanceReceived: 0,
            totalPaid: 0,
            totalRemaining: 0,
          },
        });
      }

      const group = customerMap.get(key);

      const imeiSerial = archivedDelivery?.product_imei || order.imei_serial || null;
      const invInfo = imeiSerial ? inventoryMap.get(imeiSerial) : null;

      const productName = invInfo?.product_name || archivedPlan?.productName || order.product_name;
      const colorVariant = invInfo?.color_variant || archivedPlan?.delivered_color || archivedPlan?.color || null;

      const normalized = getNormalizedLedger(archivedDelivery?.installment_ledger?.ledger_rows);
      const { advance_payment: advancePayment, installment_ledger: installmentLedger, summary } = normalized;

      const advanceAmount = advancePayment.amount || 0;
      const grandTotalPaid = summary.grandTotalPaid;
      const grandTotalRemaining = summary.grandTotalRemaining;

      group.orders.push({
        order_id: order.id,
        order_ref: order.order_ref,
        status: order.status,
        clear_reason: 'returned',
        customer_name: order.customer_name,
        verification: order.verification,
        product_details: {
          product_name: productName,
          imei_serial: imeiSerial,
          color_variant: colorVariant,
        },
        ledger: {
          summary: summary,
          installment_ledger: installmentLedger,
        },
      });

      group.ledgerSummary.totalOrders += 1;
      group.ledgerSummary.totalAdvanceReceived += advanceAmount;
      group.ledgerSummary.totalPaid += grandTotalPaid;
      group.ledgerSummary.totalRemaining += grandTotalRemaining;
    }

    // Newest-cleared-first, so a just-processed return/payoff shows at the top
    const allCleared = Array.from(customerMap.values()).sort((a, b) =>
      new Date(b.customer.cleared_at).getTime() - new Date(a.customer.cleared_at).getTime()
    );

    return res.status(200).json({
      success: true,
      data: {
        customers: allCleared,
        total: allCleared.length,
      },
    });
  } catch (error) {
    console.error('Error in getClearedCustomers:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getCustomerLedger = async (req, res) => {
  const { orderRef } = req.params;

  if (!orderRef) {
    return res.status(400).json({ success: false, message: 'Order reference is required.' });
  }

  try {
    const order = await prisma.order.findUnique({
      where: { order_ref: orderRef },
      include: {
        verification: {
          include: {
            purchaser: true,
          },
        },
        delivery: {
          include: {
            installment_ledger: true,
          },
        },
        installment_ledger: true,
        archived_deliveries: {
          orderBy: { archived_at: 'desc' },
          take: 1,
        },
        cash_in_hand: {
          take: 1,
          orderBy: { created_at: 'desc' },
        },
        outlet: {
          select: {
            name: true,
            code: true
          }
        }
      }
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    // ── Pre-fetch Inventory details based on IMEI ──────────────────
    const archivedDelivery = order.archived_deliveries?.[0] || null;
    const imeiSerial = order.cash_in_hand?.[0]?.imei_serial || order.delivery?.product_imei || archivedDelivery?.product_imei || order.imei_serial || null;

    let invInfo = null;
    if (imeiSerial) {
      invInfo = await prisma.outletInventory.findFirst({
        where: { imei_serial: imeiSerial },
        select: { imei_serial: true, product_name: true }
      });
    }

    const purchaser = order.verification?.purchaser || null;
    // For a returned order, the live ledger was cascade-deleted along with
    // its Delivery row — the only surviving snapshot is the Json blob
    // captured on the ArchivedDelivery at return time.
    const ledgerModel = order.installment_ledger || order.delivery?.installment_ledger || archivedDelivery?.installment_ledger;
    const cashRecord = order.cash_in_hand?.[0] || null;

    let plan = order.delivery?.selected_plan || archivedDelivery?.selected_plan || null;
    if (typeof plan === 'string') {
      try { plan = JSON.parse(plan); } catch (e) { plan = null; }
    }

    const normalized = getNormalizedLedger(ledgerModel?.ledger_rows);
    const { advance_payment, installment_ledger: installmentLedger, summary } = normalized;

    const advanceAmount = advance_payment.amount || 0;
    const monthlyAmount = installmentLedger[0]?.dueAmount || plan?.monthly_amount || plan?.monthlyAmount || order.monthly_amount || 0;
    const totalMonths = installmentLedger.length || plan?.months || plan?.duration || order.months || 0;

    const formatted = {
      order_id: order.id,
      order_ref: order.order_ref,
      customer_name: purchaser?.name || order.customer_name,
      whatsapp_number: order.whatsapp_number,
      product_name: invInfo?.product_name || cashRecord?.product_name || order.product_name,
      imei_serial: imeiSerial,
      status: order.status,
      created_at: order.created_at,
      outlet_name: order.outlet?.name || 'N/A',
      outlet_code: order.outlet?.code || 'N/A',
      ledgerSummaries: {
        advanceAmount,
        monthlyAmount,
        totalMonths,
        totalInstallmentDue: summary.totalInstallmentDue,
        totalInstallmentPaid: summary.totalInstallmentPaid,
        totalRemaining: summary.totalInstallmentRemaining,
        totalArrears: summary.totalArrears || 0,
        paidInstallments: summary.paidInstallments,
        totalInstallments: installmentLedger.length,
      },
      installmentLedger,
      ledger_short_id: ledgerModel?.short_id || ledgerModel?.token || null
    };

    res.json({
      success: true,
      data: {
        installments: [formatted]
      }
    });
  } catch (error) {
    console.error('getCustomerLedger error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  getCustomers,
  getBlacklistedCustomers,
  getClearedCustomers,
  getCustomerLedger
};

