const prisma = require('../../lib/prisma');
const { syncBlacklistStatus } = require('../utils/blacklistUtils');
const { getNormalizedLedger, computeDueAndCurrent } = require('../utils/ledgerUtils');
const { EXCLUDE_PENDING_LEGACY_IMPORT } = require('../utils/legacyImportFilter');
const { BLACKLIST_REASON_TYPES, classifyBlacklistReason } = require('../utils/blacklistReasonUtils');

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

const cleanValue = (value) => (typeof value === 'string' && value.trim() && value.trim() !== '-' ? value.trim() : null);

// Addresses reach us in two shapes: the app's composed
// "H# .., St# .., Block .., <Zone>, <Area>, <City>" (see customAddressZone.dart)
// and free-typed legacy text. Folding both onto the same token stream lets one
// matcher serve both — punctuation, the "No."/"#" noise and the hyphens in
// "Gulshan-e-Iqbal" carry no meaning for the comparison.
const normalizeAddressText = (value) =>
  (value || '')
    .toLowerCase()
    .replace(/[.,#/\\()]/g, ' ')
    .replace(/[-_]+/g, ' ')
    // "no1" / "13d" / "5a" are written both ways in the wild — splitting the
    // letter/digit seam makes "Landhi No1" and "Landhi No. 1" the same tokens.
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/\bblk\b/g, 'block')
    .replace(/\bsect?r?\b/g, 'sector')
    .replace(/\bno\b/g, ' ')
    // The "-e-" connector in Gulshan-e-Iqbal / Khayaban-e-Ittehad is dropped as
    // often as it is typed; ignoring it on both sides makes the two spellings equal.
    .replace(/\be\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Builds an area resolver over the Area/Zone tables.
 *
 * Only a minority of records carry a structured `present_area` — the rest keep
 * the area buried inside the address string, which is why the Area column read
 * "-" for so many rows. The resolver walks three tiers, widest confidence first,
 * and reports which tier answered so the UI can flag the weaker ones.
 */
const buildAreaResolver = (areaNames, zoneNames) => {
  // Longest name first: "Korangi No. 3.5" must win over the "Korangi" that is
  // also a substring of it.
  const toIndex = (names) =>
    names
      .map((name) => ({ name: (name || '').trim(), norm: normalizeAddressText(name) }))
      .filter((entry) => entry.name && entry.norm)
      .sort((a, b) => b.norm.length - a.norm.length);

  const areaIndex = toIndex(areaNames);
  const zoneIndex = toIndex(zoneNames);

  // Space-padded containment = whole-token match, so "Gulberg" cannot be found
  // inside "Gulbergabad" while "Gulberg Town" still matches mid-address.
  const findIn = (index, text) => {
    const normalized = normalizeAddressText(text);
    if (!normalized) return null;
    const haystack = ` ${normalized} `;
    return index.find((entry) => haystack.includes(` ${entry.norm} `))?.name || null;
  };

  return ({ areas = [], addresses = [], landmarks = [] }) => {
    const structured = areas.map(cleanValue).find(Boolean);
    if (structured) return { area: structured, source: 'field' };

    for (const text of [...addresses, ...landmarks]) {
      const match = findIn(areaIndex, text);
      if (match) return { area: match, source: 'address' };
    }

    // Nothing matched a real area. The composed address still ends
    // "<Zone>, <City>" when the officer skipped the area dropdown, so fall back
    // to the district rather than showing nothing. Landmarks are excluded here —
    // a one-word zone name matches far too easily inside free text.
    for (const text of addresses) {
      const match = findIn(zoneIndex, text);
      if (match) return { area: match, source: 'zone' };
    }

    return { area: null, source: null };
  };
};

const AUTO_BLACKLIST_REASON = 'Auto-flagged (90+ days delinquency)';
const NINETY_DAYS_MS = 90 * 86400000;

/**
 * Replays the 90-day rule from syncBlacklistStatus to recover WHEN an account
 * was automatically blacklisted.
 *
 * Accounts flagged before BlacklistAction logging existed have no audit row at
 * all, which is why their Blacklist Date read "Not recorded". The rule itself is
 * deterministic, so the trigger date can be recomputed: 90 days past the
 * earliest unpaid installment, or 90 days past delivery when nothing was ever
 * paid. Whichever came first is the day the account first qualified.
 */
const deriveAutoFlagDate = (installmentLedger, deliveredAt) => {
  const rows = Array.isArray(installmentLedger) ? installmentLedger : [];
  if (rows.length === 0) return null;

  const isPaid = (row) => (row.status || '').toLowerCase() === 'paid';
  const triggers = [];

  const unpaidDueDates = rows
    .filter((row) => !isPaid(row))
    .map((row) => (row.dueDate ? new Date(row.dueDate) : null))
    .filter((date) => date && !isNaN(date.getTime()))
    .map((date) => date.getTime());
  if (unpaidDueDates.length) triggers.push(Math.min(...unpaidDueDates) + NINETY_DAYS_MS);

  const delivered = deliveredAt ? new Date(deliveredAt) : null;
  if (rows.every((row) => !isPaid(row)) && delivered && !isNaN(delivered.getTime())) {
    triggers.push(delivered.getTime() + NINETY_DAYS_MS);
  }

  if (!triggers.length) return null;

  const earliest = Math.min(...triggers);
  // A trigger still in the future means the automatic rule never fired for this
  // account — it was blacklisted by hand, so don't invent an automatic date.
  return earliest > Date.now() ? null : new Date(earliest);
};

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
    const baseWhere = { is_delivered: true, AND: [EXCLUDE_PENDING_LEGACY_IMPORT] };

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
        AND: [
          {
            verification: {
              OR: [
                { purchaser: { is_blacklisted: true } },
                { grantors: { some: { is_blacklisted: true } } },
              ],
            },
          },
          EXCLUDE_PENDING_LEGACY_IMPORT,
        ],
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
        statusHistories: {
          where: { new_status: 'delivered' },
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

    const [knownAreas, knownZones] = await Promise.all([
      prisma.area.findMany({ select: { name: true } }),
      prisma.zone.findMany({ select: { name: true } }),
    ]);
    const resolveArea = buildAreaResolver(
      knownAreas.map(a => a.name),
      knownZones.map(z => z.name)
    );

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
      const installmentLedgerModel = order.installment_ledger || delivery?.installment_ledger || null;
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

      // Full guarantor roster for this order — surfaced so the UI can nest
      // guarantor details under the customer row instead of only exposing
      // the "which role triggered the blacklist" badge.
      const guarantors = (order.verification?.grantors || []).map((g) => {
        const resolvedArea = resolveArea({
          areas: [g.present_area, g.permanent_area],
          addresses: [g.present_address, g.full_residential_address, g.permanent_address],
          landmarks: [g.nearest_location],
        });
        return {
          id: g.id,
          name: g.name,
          cnic_number: g.cnic_number || null,
          telephone_number: g.telephone_number || null,
          relationship: g.relationship || null,
          grantor_number: g.grantor_number,
          area: resolvedArea.area,
          area_source: resolvedArea.source,
          present_address: g.present_address || null,
          permanent_address: g.permanent_address || null,
          is_blacklisted: !!g.is_blacklisted,
        };
      });

      if (!customerMap.has(key)) {
        const resolvedArea = resolveArea({
          areas: [purchaser?.present_area, order.area, purchaser?.permanent_area],
          addresses: [purchaser?.present_address, order.address, purchaser?.permanent_address],
          landmarks: [purchaser?.nearest_location],
        });
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
            area: resolvedArea.area,
            // 'field' = stored area column, 'address' = parsed out of the address
            // text, 'zone' = only the district could be identified.
            area_source: resolvedArea.source,
            profile_photo: profilePhoto,
            is_blacklisted: isAccountBlacklisted, // Marker for UI
            created_at: order.created_at,
            delivered_at: order.delivered_at || delivery?.end_time || order.statusHistories?.[0]?.created_at || null,
            // Replayed 90-day trigger, filled in below — the fallback for
            // accounts blacklisted before BlacklistAction rows were written.
            auto_flag_date: null,
            blacklisted_role: blacklistedRole,
            recovery_officer_name: order.recovery_officer?.full_name || null,
            guarantors,
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

      // Earliest day any of this account's orders crossed the automatic
      // 90-day threshold — used as the blacklist date when no audit row exists.
      const orderAutoFlagDate = deriveAutoFlagDate(installmentLedger, group.customer.delivered_at);
      if (orderAutoFlagDate && (!group.customer.auto_flag_date || orderAutoFlagDate < group.customer.auto_flag_date)) {
        group.customer.auto_flag_date = orderAutoFlagDate;
      }

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

    // Attach manual/auto blacklist reason, blacklist date, actor, and
    // pending-whitelist status — for the customer AND for every guarantor
    // listed under them, each resolved from their own CNIC's BlacklistAction
    // history (syncBlacklistStatus now logs one for auto-flagged accounts too).
    //
    // Accounts flagged before that logging landed have no row at all. Rather
    // than leaving them as "Not recorded", fall back to the replayed 90-day
    // trigger date so the list can still answer "when did this happen".
    const applyDefaultBlacklistMeta = (entity, autoFlagDate) => {
      entity.blacklist_reason = autoFlagDate ? AUTO_BLACKLIST_REASON : 'Blacklist history not recorded';
      entity.blacklist_date = autoFlagDate || null;
      entity.blacklist_date_source = autoFlagDate ? 'auto-estimated' : null;
      entity.blacklist_status = 'Blacklisted';
      entity.blacklisted_by_name = autoFlagDate ? 'System (Auto-flagged)' : null;
      const type = classifyBlacklistReason({ isAuto: !!autoFlagDate, reason: null });
      entity.blacklist_reason_code = type.code;
      entity.blacklist_reason_label = type.label;
    };
    // A guarantor riding along on a blacklisted order isn't necessarily
    // blacklisted themself — only give them reason/date/status/actor when
    // their own is_blacklisted flag is actually set, otherwise it would
    // falsely read as "Blacklisted" for someone who isn't.
    const applyDefaultGuarantorMeta = (autoFlagDate) => (g) => {
      if (g.is_blacklisted) {
        // The sync blacklists purchaser and guarantors in one pass, so the
        // account's trigger date is the guarantor's trigger date too.
        applyDefaultBlacklistMeta(g, autoFlagDate);
      } else {
        g.blacklist_reason = null;
        g.blacklist_date = null;
        g.blacklist_date_source = null;
        g.blacklist_status = null;
        g.blacklisted_by_name = null;
        g.blacklist_reason_code = null;
        g.blacklist_reason_label = null;
      }
    };
    for (const c of allBlacklisted) {
      applyDefaultBlacklistMeta(c.customer, c.customer.auto_flag_date);
      (c.customer.guarantors || []).forEach(applyDefaultGuarantorMeta(c.customer.auto_flag_date));
    }

    const normalizeCnic = (value) => (value || '').replace(/[^0-9]/g, '');
    const cnics = Array.from(new Set(
      allBlacklisted.flatMap(c => [
        c.customer.cnic_number,
        ...((c.customer.guarantors || []).map(g => g.cnic_number)),
      ]).filter(Boolean)
    ));

    if (cnics.length > 0) {
      const actions = await prisma.blacklistAction.findMany({
        where: { cnic: { in: Array.from(new Set(cnics.flatMap(cnic => {
          const digits = normalizeCnic(cnic);
          return [cnic, digits, digits.length === 13 ? `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}` : cnic];
        }))) } },
        include: { created_by: { select: { full_name: true } } },
        orderBy: { created_at: 'desc' }
      });

      // Older manual actions can survive in the audit log even when the
      // corresponding blacklist history row is missing. Use only an exact CNIC match.
      const recordedCnics = new Set(actions.filter(a => a.action === 'blacklist').map(a => normalizeCnic(a.cnic)));
      const missingCnics = cnics.filter(cnic => !recordedCnics.has(normalizeCnic(cnic)));
      if (missingCnics.length) {
        const logs = await prisma.securityLog.findMany({
          where: {
            action: 'MANUAL_BLACKLIST',
            OR: missingCnics.flatMap(cnic => {
              const digits = normalizeCnic(cnic);
              const formatted = digits.length === 13 ? `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}` : cnic;
              return [cnic, digits, formatted].filter(Boolean).map(value => ({ details: { contains: value } }));
            }),
          },
          select: { details: true, created_at: true, user_name: true },
          orderBy: { created_at: 'desc' },
        });
        const missingKeys = new Set(missingCnics.map(normalizeCnic));
        for (const log of logs) {
          const cnic = normalizeCnic(log.details.match(/CNIC\s+([\d-]+)/i)?.[1]);
          if (!cnic || !missingKeys.has(cnic)) continue;
          actions.push({ cnic, action: 'blacklist', status: 'approved', reason: log.details,
            created_at: log.created_at, created_by: { full_name: log.user_name } });
          missingKeys.delete(cnic);
        }
        actions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      }

      // Latest "blacklist" action per cnic — drives reason + blacklist date + actor.
      const blacklistActionMap = new Map();
      // Latest action of any kind per cnic — a pending whitelist request overrides the "Blacklisted" status.
      const latestActionMap = new Map();
      for (const a of actions) {
        a.cnic = normalizeCnic(a.cnic);
        if (!latestActionMap.has(a.cnic)) latestActionMap.set(a.cnic, a);
        if (a.action === 'blacklist' && !blacklistActionMap.has(a.cnic)) blacklistActionMap.set(a.cnic, a);
      }

      const applyBlacklistMeta = (entity, autoFlagDate) => {
        const cnic = normalizeCnic(entity.cnic_number);
        const blacklistAction = cnic ? blacklistActionMap.get(cnic) : null;
        const latestAction = cnic ? latestActionMap.get(cnic) : null;

        if (blacklistAction) {
          entity.blacklist_reason = blacklistAction.reason || 'Manual blacklist (No reason provided)';
          entity.blacklist_date = blacklistAction.created_at;
          entity.blacklist_date_source = 'recorded';
          entity.blacklisted_by_name = blacklistAction.created_by?.full_name
            || (blacklistAction.category === 'auto' ? 'System (Auto-flagged)' : 'Not recorded');
          // Free-text reasons are unbounded, so every record also carries the
          // canonical bucket the Reason filter actually works on.
          const type = classifyBlacklistReason({
            category: blacklistAction.category,
            reason: blacklistAction.reason,
            isAuto: blacklistAction.category === 'auto',
          });
          entity.blacklist_reason_code = type.code;
          entity.blacklist_reason_label = type.label;
        } else {
          applyDefaultBlacklistMeta(entity, autoFlagDate);
        }

        entity.blacklist_status = (latestAction?.action === 'whitelist' && latestAction.status === 'pending')
          ? 'Pending Whitelist'
          : 'Blacklisted';
      };

      for (const c of allBlacklisted) {
        applyBlacklistMeta(c.customer, c.customer.auto_flag_date);
        (c.customer.guarantors || [])
          .filter(g => g.is_blacklisted)
          .forEach(g => applyBlacklistMeta(g, c.customer.auto_flag_date));
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        customers: allBlacklisted,
        total: allBlacklisted.length,
        totalDueAmount: allBlacklisted.reduce((s, c) => s + (c.ledgerSummary.totalDue || 0), 0),
        totalCurrentAmount: allBlacklisted.reduce((s, c) => s + (c.ledgerSummary.totalCurrent || 0), 0),
        // The Reason filter's fixed vocabulary, sent from here so the backend
        // stays the single source of truth for it — the dropdown used to be
        // built from distinct free-text reasons, which grew by one option for
        // every typo an officer ever entered.
        reasonTypes: BLACKLIST_REASON_TYPES,
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
    const baseWhere = { is_delivered: true, AND: [EXCLUDE_PENDING_LEGACY_IMPORT] };


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

    // Fetch returned orders — these are also "cleared" (account settled via
    // return rather than full payment), but their Delivery/InstallmentLedger
    // rows were deleted at return time, so their ledger snapshot only
    // survives in archived_deliveries. Only shown here once 3 days have
    // passed since the return itself — until then they're still visible in
    // the outlet's Returns list, not here. A still-blacklisted account is
    // included too (marked as such) rather than excluded outright; the
    // account itself only leaves Blacklisted Customers once an admin
    // whitelists it separately.
    const RETURN_CLEARED_DELAY_MS = 3 * 24 * 60 * 60 * 1000;
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
        return_exchanges: {
          where: { type: 'Return', status: 'verified' },
          orderBy: { verified_at: 'desc' },
          take: 1,
        },
      },
    });

    const nowForClearGate = new Date();
    const returnedOrders = returnedOrdersRaw.filter(order => {
      const returnTimestamp = order.return_exchanges?.[0]?.verified_at || order.return_exchanges?.[0]?.created_at;
      if (!returnTimestamp) return false;
      return nowForClearGate.getTime() - new Date(returnTimestamp).getTime() >= RETURN_CLEARED_DELAY_MS;
    });

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

      const isStillBlacklisted = !!(
        order.customer?.is_blacklisted ||
        order.verification?.purchaser?.is_blacklisted ||
        order.verification?.grantors?.some(g => g.is_blacklisted)
      );

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
            is_blacklisted: isStillBlacklisted,
            clear_reason: isStillBlacklisted ? 'returned_blacklisted' : 'returned',
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
        clear_reason: isStillBlacklisted ? 'returned_blacklisted' : 'returned',
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
  getCustomerLedger,
  // Exported for direct exercising against real address/ledger data.
  buildAreaResolver,
  deriveAutoFlagDate,
};

