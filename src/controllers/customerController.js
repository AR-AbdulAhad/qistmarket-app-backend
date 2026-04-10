const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const getCustomers = async (req, res) => {
 const {
    page    = 1,
    limit   = 10,
    search  = '',
  } = req.query;
 
  const pageNum  = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
  const skip     = (pageNum - 1) * limitNum;
  const q        = search.trim();
 
  try {
    const orderWhere = {
      is_delivered: true,
      ...(q && {
        OR: [
          // PurchaserVerification fields
          { verification: { purchaser: { name:             { contains: q } } } },
          { verification: { purchaser: { cnic_number:      { contains: q } } } },
          { verification: { purchaser: { telephone_number: { contains: q } } } },
          // Order whatsapp fallback
          { whatsapp_number: { contains: q } },
          // Delivery product_imei
          { delivery: { product_imei: { contains: q } } },
          // CashInHand product_name, imei_serial
          { cash_in_hand: { some: { product_name: { contains: q } } } },
          { cash_in_hand: { some: { imei_serial:  { contains: q } } } },
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
 
    // ── Group by customer (whatsapp_number) ────────────────────
    const customerMap = new Map();
 
    for (const order of orders) {
      const key = (order.whatsapp_number || `unknown-${order.id}`).trim();
 
      const purchaser              = order.verification?.purchaser || null;
      const cashInHand             = order.cash_in_hand?.[0]       || null;
      const delivery               = order.delivery;
      const installmentLedgerModel = delivery?.installment_ledger   || null;
      const profilePhoto           = order.verification?.documents?.[0]?.file_url || null;
 
      // ── Customer details: purchaser se, fallback Order ────────
      const customerName      = purchaser?.name                || order.customer_name;
      const fatherHusbandName = purchaser?.father_husband_name || null;
      const cnicNumber        = purchaser?.cnic_number         || null;
      const presentAddress    = purchaser?.present_address     || order.address || null;
      const permanentAddress  = purchaser?.permanent_address   || null;
      const telephoneNumber   = purchaser?.telephone_number    || order.whatsapp_number;
      const nearestLocation   = purchaser?.nearest_location    || null;
 
      if (!customerMap.has(key)) {
        customerMap.set(key, {
          customer: {
            name:                customerName,
            father_husband_name: fatherHusbandName,
            cnic_number:         cnicNumber,
            whatsapp_number:     order.whatsapp_number,
            telephone_number:    telephoneNumber,
            present_address:     presentAddress,
            permanent_address:   permanentAddress,
            nearest_location:    nearestLocation,
            city:                order.city,
            area:                order.area,
            profile_photo:       profilePhoto,
          },
          orders: [],
          ledgerSummary: {
            totalOrders:          0,
            totalAdvanceReceived: 0,
            totalPaid:            0,
            totalRemaining:       0,
          },
        });
      }
 
      const group = customerMap.get(key);
 
      // ── Delivery date ──────────────────────────────────────────
      const deliveryDate = delivery?.end_time || order.updated_at;
 
      // ── Product info: Fetch from Inventory via IMEI first ───────────────────────────
      const imeiSerial   = cashInHand?.imei_serial   || delivery?.product_imei || order.imei_serial || null;
      const invInfo      = imeiSerial ? inventoryMap.get(imeiSerial) : null;
      
      const productName  = invInfo?.product_name  || cashInHand?.product_name  || order.product_name;
      const colorVariant = invInfo?.color_variant || cashInHand?.color_variant || null;
 
      // ── Advance: CashInHand.amount ─────────────────────────────
      // Default from cashInHand (fallback if no ledger row 0 exists)
      let advanceAmount  = cashInHand?.amount != null ? Number(cashInHand.amount) : 0;
      let hasPaidAdvance = !!cashInHand;
      let advancePaidAt        = cashInHand?.created_at     || null;
      let advancePaymentMethod = cashInHand?.payment_method || null;

      // ── Plan info: Delivery.selected_plan se ──────────────────
      let selectedPlan = delivery?.selected_plan || null;
      if (typeof selectedPlan === 'string') {
        try { selectedPlan = JSON.parse(selectedPlan); } catch { selectedPlan = null; }
      }

      // ── Installment Ledger: parse ledger_rows ─────────────────
      // month === 0  →  Advance Payment row
      // month  > 0  →  Monthly installment rows
      let installmentLedger = [];

      if (installmentLedgerModel?.ledger_rows) {
        const allLedgerRows = Array.isArray(installmentLedgerModel.ledger_rows)
          ? installmentLedgerModel.ledger_rows
          : [];

        // Extract advance from month 0 row
        const advanceLedgerRow = allLedgerRows.find(r => r.month === 0);
        if (advanceLedgerRow) {
          advanceAmount        = Number(advanceLedgerRow.amount || 0);
          hasPaidAdvance       = advanceLedgerRow.status === 'paid';
          advancePaidAt        = advanceLedgerRow.paid_at  || advanceLedgerRow.paidAt  || null;
          advancePaymentMethod = advanceLedgerRow.payment_method || advanceLedgerRow.paymentMethod || 'Cash';
        }

        // Map only month > 0 rows as installments
        installmentLedger = allLedgerRows
          .filter(r => r.month > 0)
          .map((row) => {
            const rowDueAmount = Number(row.amount || row.dueAmount || row.due_amount || 0);
            const rowStatus    = row.status || 'pending';
            const isPaid       = rowStatus === 'paid';
            return {
              monthNumber:     row.month,
              label:           row.label || `Month ${row.month}`,
              dueDate:         row.due_date  || row.dueDate  || null,
              dueAmount:       rowDueAmount,
              paidAmount:      isPaid ? rowDueAmount : 0,
              remainingAmount: isPaid ? 0 : rowDueAmount,
              status:          rowStatus,
              paidAt:          row.paid_at   || row.paidAt   || null,
              paymentMethod:   row.payment_method || row.paymentMethod || null,
            };
          });
      }

      const advancePayment = {
        amount:        advanceAmount,
        paid:          hasPaidAdvance,
        paidAt:        advancePaidAt,
        paymentMethod: advancePaymentMethod,
        status:        hasPaidAdvance ? 'paid' : 'pending',
      };

      // Use actual row amounts (not plan formula) for accurate totals
      const monthlyAmount = installmentLedger[0]?.dueAmount
        || Number(selectedPlan?.monthly_amount || selectedPlan?.monthlyAmount || 0);
      const totalMonths = installmentLedger.length
        || Number(selectedPlan?.months || selectedPlan?.totalMonths || 0);

      const paidInstallments    = installmentLedger.filter((r) => r.status === 'paid').length;
      const pendingInstallments = installmentLedger.filter((r) => r.status !== 'paid').length;

      // ── Financial Summary ──────────────────────────────────────
      const totalInstallmentDue       = installmentLedger.reduce((sum, r) => sum + r.dueAmount, 0);
      const totalInstallmentPaid      = installmentLedger
        .filter((r) => r.status === 'paid')
        .reduce((sum, r) => sum + r.dueAmount, 0);
      const totalInstallmentRemaining = Math.max(0, totalInstallmentDue - totalInstallmentPaid);

      const grandTotalDue       = advanceAmount + totalInstallmentDue;
      const grandTotalPaid      = (hasPaidAdvance ? advanceAmount : 0) + totalInstallmentPaid;
      const grandTotalRemaining = Math.max(0, grandTotalDue - grandTotalPaid);

 
      group.orders.push({
        order_id:            order.id,
        order_ref:           order.order_ref,
        token_number:        order.token_number,
        status:              order.status,
        is_delivered:        true,
        delivery_date:       deliveryDate ? deliveryDate.toISOString() : null,
        created_at:          order.created_at.toISOString(),
        verification_status: order.verification?.status || null,
 
        product_details: {
          product_name:  productName,
          imei_serial:   imeiSerial,
          color_variant: colorVariant,
        },
 
        plan: {
          selected_plan:    selectedPlan,
          advance_amount:   advanceAmount,
          monthly_amount:   monthlyAmount,
          months:           totalMonths,
          total_plan_value: grandTotalDue,
        },
 
        ledger: {
          advance_payment:    advancePayment,
          installment_ledger: installmentLedger,
          ledger_token:       installmentLedgerModel?.short_id || null,
          summary: {
            totalInstallmentDue,
            totalInstallmentPaid,
            totalInstallmentRemaining,
            grandTotalDue,
            grandTotalPaid,
            grandTotalRemaining,
            paidInstallments,
            pendingInstallments,
            installmentsStarted:  totalMonths > 0,
            firstInstallmentDate: installmentLedger[0]?.dueDate ?? null,
          },
        },
      });
 
      // ── Customer ledger summary update ─────────────────────────
      group.ledgerSummary.totalOrders          += 1;
      group.ledgerSummary.totalAdvanceReceived += advanceAmount;
      group.ledgerSummary.totalPaid            += grandTotalPaid;
      group.ledgerSummary.totalRemaining       += grandTotalRemaining;
    }
 
    // ── Sort customers alphabetically ──────────────────────────
    let allCustomers = Array.from(customerMap.values()).sort((a, b) =>
      a.customer.name.localeCompare(b.customer.name)
    );
 
    // DB filter already handles all search cases — no post-group filter needed
 
    // ── Pagination on grouped customers ───────────────────────
    const totalCustomers = allCustomers.length;
    const totalPages     = Math.ceil(totalCustomers / limitNum);
    const paginatedCustomers = allCustomers.slice(skip, skip + limitNum);
 
    return res.status(200).json({
      success: true,
      data: {
        customers: paginatedCustomers,
        pagination: {
          page:       pageNum,
          limit:      limitNum,
          total:      totalCustomers,
          totalPages,
          hasNext:    pageNum < totalPages,
          hasPrev:    pageNum > 1,
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

module.exports = {
    getCustomers
};
