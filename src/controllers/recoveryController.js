const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { updateCashRegister } = require('../utils/cashRegisterUtils');

const getExpectedWorkMinutes = (startStr, endStr) => {
  if (!startStr || !endStr) return 480; // 8h default
  const parseTime = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  let diff = parseTime(endStr) - parseTime(startStr);
  if (diff < 0) diff += 24 * 60;
  return diff;
};

const getAllRecoveryOfficers = async (req, res) => {
  try {
    const officers = await prisma.user.findMany({
      where: { role: { name: 'Recovery Officer' } },
      select: {
        id: true,
        full_name: true,
        username: true,
        phone: true,
        status: true,
        is_online: true,
        last_known_latitude: true,
        last_known_longitude: true,
        last_online_at: true,
        bike_km_range: true,
        working_hours_start: true,
        working_hours_end: true,
        recovery_orders: {
          where: { status: 'delivered' }, // Active recovery jobs
          select: {
            id: true,
            status: true,
            order_ref: true,
            customer_name: true,
          },
          take: 1,
        },
      },
      orderBy: { full_name: 'asc' },
    });

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthlyStatsRaw = await prisma.officerSession.groupBy({
      by: ['officer_id'],
      where: { start_time: { gte: startOfMonth } },
      _sum: { duration_minutes: true },
    });

    const monthlyStatsMap = new Map(
      monthlyStatsRaw.map((s) => [s.officer_id, ((s._sum.duration_minutes || 0) / 60).toFixed(2)])
    );

    const formatted = officers.map((o) => ({
      id: o.id,
      full_name: o.full_name,
      username: o.username,
      phone: o.phone,
      account_status: o.status,
      is_online: o.is_online,
      current_location:
        o.is_online && o.last_known_latitude
          ? { latitude: o.last_known_latitude, longitude: o.last_known_longitude }
          : null,
      last_known_location:
        !o.is_online && o.last_known_latitude
          ? {
            latitude: o.last_known_latitude,
            longitude: o.last_known_longitude,
            timestamp: o.last_online_at,
          }
          : null,
      bike_km_range: o.bike_km_range,
      working_hours:
        o.working_hours_start && o.working_hours_end
          ? `${o.working_hours_start} - ${o.working_hours_end}`
          : null,
      current_assignment: o.recovery_orders[0] ? {
        id: o.recovery_orders[0].id,
        status: o.recovery_orders[0].status,
        order: {
          order_ref: o.recovery_orders[0].order_ref,
          customer_name: o.recovery_orders[0].customer_name
        }
      } : null,
      monthly_online_hours: monthlyStatsMap.get(o.id) || '0.00',
    }));

    return res.json({ success: true, data: { officers: formatted } });
  } catch (error) {
    console.error('getAllRecoveryOfficers error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const getRecoveryOfficerStats = async (req, res) => {
  const { id } = req.params;
  const { month, year } = req.query;

  try {
    const officer = await prisma.user.findUnique({
      where: { id: parseInt(id) },
      select: { working_hours_start: true, working_hours_end: true },
    });

    if (!officer) return res.status(404).json({ success: false, error: 'Officer not found' });

    let startDate, endDate;
    if (year && month) {
      startDate = new Date(Number(year), Number(month) - 1, 1);
      endDate = new Date(Number(year), Number(month), 0);
    } else {
      const now = new Date();
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    }

    const sessions = await prisma.officerSession.findMany({
      where: {
        officer_id: parseInt(id),
        start_time: { gte: startDate, lte: endDate },
      },
      select: { start_time: true, duration_minutes: true },
    });

    const dailyMap = new Map();
    sessions.forEach((s) => {
      const dateKey = s.start_time.toISOString().split('T')[0];
      dailyMap.set(dateKey, (dailyMap.get(dateKey) || 0) + (s.duration_minutes || 0));
    });

    const expectedDailyMin = getExpectedWorkMinutes(officer.working_hours_start, officer.working_hours_end);
    const expectedDailyHours = (expectedDailyMin / 60).toFixed(2);

    const dailyStats = [];
    let current = new Date(startDate);
    while (current <= endDate) {
      const dateKey = current.toISOString().split('T')[0];
      const onlineMin = dailyMap.get(dateKey) || 0;
      const onlineHours = (onlineMin / 60).toFixed(2);
      const offlineDuringWork = Math.max(0, Number(expectedDailyHours) - Number(onlineHours)).toFixed(2);

      dailyStats.push({
        date: dateKey,
        online_hours: onlineHours,
        worked_hours: onlineHours,
        offline_during_work_hours: offlineDuringWork,
      });

      current.setDate(current.getDate() + 1);
    }

    return res.json({
      success: true,
      data: {
        officer_id: Number(id),
        month: startDate.toISOString().slice(0, 7),
        daily_stats: dailyStats,
        expected_daily_hours: expectedDailyHours,
      },
    });
  } catch (error) {
    console.error('getRecoveryOfficerStats error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

const getRecoveryCustomers = async (req, res) => {
  const officerId = req.user.id;

  try {
    const orders = await prisma.order.findMany({
      where: {
        recovery_officer_id: officerId,
      },
      include: {
        payments: true,
        delivery: {
          include: {
            installment_ledger: true,
          },
        },
        cash_in_hand: true,
      },
      orderBy: [{ customer_name: 'asc' }, { created_at: 'desc' }],
    });

    if (orders.length === 0) {
      return res.status(200).json({ success: true, data: { customers: [] } });
    }

    const customerMap = new Map();

    for (const order of orders) {
      const key = (order.whatsapp_number || `unknown-${order.id}`).trim();

      if (!customerMap.has(key)) {
        customerMap.set(key, {
          customer: {
            name: order.customer_name,
            whatsapp_number: order.whatsapp_number,
            address: order.address,
            city: order.city,
            area: order.area,
          },
          orders: [],
        });
      }

      const group = customerMap.get(key);
      const delivery = order.delivery;
      const cashInHand = order.cash_in_hand?.[0] || null;
      const installmentLedgerModel = delivery?.installment_ledger || null;

      // ── Delivery status ────────────────────────────────────────
      const isDelivered = order.is_delivered || delivery?.status === 'completed';
      const deliveryDate = isDelivered
        ? delivery?.end_time || order.updated_at
        : null;

      // ── ALL product info from CashInHand ───────────────────────
      const productName    = cashInHand?.product_name   || null;
      const imeiSerial     = cashInHand?.imei_serial    || delivery?.product_imei || null;
      const colorVariant   = cashInHand?.color_variant  || null;
      const advanceAmount  = cashInHand?.amount         || 0;
      const selectedPlan   = delivery?.selected_plan    || null;
      const monthlyAmount  = selectedPlan?.monthly_amount ?? 0;
      const totalMonths    = selectedPlan?.months        ?? 0;

      // ── Advance payment status from payments table ─────────────
      const advanceDbPayment = order.payments?.find(
        (p) => p.paymentType === 'advance'
      );
      const hasPaidAdvance = !!advanceDbPayment || !!cashInHand;

      const advancePayment = {
        amount:        advanceAmount,
        paid:          hasPaidAdvance,
        paidAt:        advanceDbPayment?.paidAt || cashInHand?.created_at || null,
        paymentMethod: advanceDbPayment?.paymentMethod || cashInHand?.payment_method || null,
        status:        hasPaidAdvance ? 'paid' : 'pending',
      };

      // ── Installment Ledger — directly from InstallmentLedger model ──
      // ledger_rows are already fully computed at delivery time, just enrich payment status
      let installmentLedger = [];

      if (installmentLedgerModel?.ledger_rows) {
        const storedRows = Array.isArray(installmentLedgerModel.ledger_rows)
          ? installmentLedgerModel.ledger_rows
          : [];

        installmentLedger = storedRows.map((row) => {
          const mNum = row.monthNumber ?? row.month_number;
          const payment = order.payments?.find(
            (p) => p.paymentType === 'installment' && p.monthNumber === mNum
          );
          return {
            ...row,
            paidAmount:     payment ? payment.amount : 0,
            remainingAmount: payment ? 0 : (row.dueAmount ?? row.due_amount ?? 0),
            status:         payment ? 'paid' : (row.status ?? 'pending'),
            paidAt:         payment?.paidAt        || null,
            paymentMethod:  payment?.paymentMethod || null,
          };
        });
      }

      const paidInstallments    = installmentLedger.filter((r) => r.status === 'paid').length;
      const pendingInstallments = installmentLedger.filter((r) => r.status !== 'paid').length;

      // ── Financial Summary ──────────────────────────────────────
      const totalPaid      = order.payments.reduce((sum, p) => sum + p.amount, 0);
      const totalDue       = advanceAmount + monthlyAmount * totalMonths;
      const totalRemaining = Math.max(0, totalDue - totalPaid);

      group.orders.push({
        id:            order.id,
        order_ref:     order.order_ref,
        status:        order.status,
        is_delivered:  isDelivered,
        delivery_date: deliveryDate,

        product_details: {
          product_name:  productName,
          imei_serial:   imeiSerial,
          color_variant: colorVariant,
        },

        plan: {
          selected_plan:  selectedPlan,
          advance_amount: advanceAmount,
          monthly_amount: monthlyAmount,
          months:         totalMonths,
        },

        ledger: {
          advance_payment:    advancePayment,
          installment_ledger: installmentLedger,
          ledger_token:       installmentLedgerModel?.short_id || null,
          summary: {
            totalDue,
            totalPaid,
            totalRemaining,
            paidInstallments,
            pendingInstallments,
            installmentsStarted:   isDelivered && totalMonths > 0,
            firstInstallmentDate:  installmentLedger[0]?.dueDate ?? installmentLedger[0]?.due_date ?? null,
          },
        },
      });
    }

    return res.json({
      success: true,
      data: { customers: Array.from(customerMap.values()) },
    });
  } catch (error) {
    console.error('getRecoveryCustomers error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

const markPaymentPaid = async (req, res) => {
  const officerId = req.user.id;
  const { order_id, paymentType, monthNumber, amount, paymentMethod = 'cash' } = req.body;

  try {
    // Check if already paid
    const existingPayment = await prisma.orderPayment.findFirst({
      where: {
        order_id: parseInt(order_id),
        paymentType,
        monthNumber: monthNumber ? parseInt(monthNumber) : null,
      },
    });

    if (existingPayment) {
      return res.status(400).json({ success: false, error: 'Already paid' });
    }

    const payment = await prisma.orderPayment.create({
      data: {
        order_id: parseInt(order_id),
        paymentType,
        monthNumber: monthNumber ? parseInt(monthNumber) : null,
        amount: parseFloat(amount),
        paymentMethod,
        collectedBy: officerId,
      }
    });

    return res.json({ success: true, data: payment, message: 'Payment recorded successfully' });
  } catch (error) {
    console.error('markPaymentPaid error:', error);
    return res.status(500).json({ success: false, error: 'Failed to record payment' });
  }
};

const getCollectionStats = async (req, res) => {
  const officerId = req.user.id;

  try {
    const cashInHand = await prisma.orderPayment.aggregate({
      where: {
        collectedBy: officerId,
        is_submitted: false,
      },
      _sum: { amount: true },
    });

    const recentCollections = await prisma.orderPayment.findMany({
      where: { collectedBy: officerId },
      orderBy: { created_at: 'desc' },
      take: 10,
      include: { order: { select: { customer_name: true, order_ref: true } } }
    });

    return res.json({
      success: true,
      data: {
        cashInHand: cashInHand._sum.amount || 0,
        recentCollections
      }
    });
  } catch (error) {
    console.error('getCollectionStats error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

const getDueOverdueInstallments = async (req, res) => {
  const officerId = req.user.id;

  try {
    const orders = await prisma.order.findMany({
      where: { recovery_officer_id: officerId, is_delivered: true },
      include: { payments: true, delivery: true }
    });

    const overdue = [];
    const now = new Date();

    for (const order of orders) {
      const deliveryDate = order.delivery?.end_time || order.updated_at;
      const totalMonths = order.months || 0;
      const monthlyAmount = order.monthly_amount || 0;

      let current = new Date(deliveryDate);
      current.setMonth(current.getMonth() + 1);
      current.setDate(5);

      for (let i = 0; i < totalMonths; i++) {
        const mNum = i + 1;
        const dueDate = new Date(current);

        if (dueDate < now) {
          const isPaid = order.payments.some(p => p.paymentType === 'installment' && p.monthNumber === mNum);
          if (!isPaid) {
            overdue.push({
              order_id: order.id,
              order_ref: order.order_ref,
              customer_name: order.customer_name,
              whatsapp_number: order.whatsapp_number,
              address: order.address,
              monthNumber: mNum,
              dueDate: dueDate.toISOString().split('T')[0],
              amount: monthlyAmount,
            });
          }
        }
        current.setMonth(current.getMonth() + 1);
      }
    }
    return res.json({ success: true, data: { overdue } });
  } catch (error) {
    console.error('getDueOverdueInstallments error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

const submitCollections = async (req, res) => {
  const officerId = req.user.id;

  try {
    const unsubmitted = await prisma.orderPayment.count({
      where: {
        collectedBy: officerId,
        is_submitted: false,
      }
    });

    // Get the total amount to submit
    const unsubmittedPayments = await prisma.orderPayment.aggregate({
      where: {
        collectedBy: officerId,
        is_submitted: false,
      },
      _sum: { amount: true }
    });
    const totalAmount = unsubmittedPayments._sum.amount || 0;

    const updated = await prisma.orderPayment.updateMany({
      where: {
        collectedBy: officerId,
        is_submitted: false,
      },
      data: {
        is_submitted: true,
        submitted_at: new Date(),
      }
    });

    // We assume the officer is assigned to an outlet
    const officer = await prisma.user.findUnique({ where: { id: officerId } });
    if (officer && officer.outlet_id && totalAmount > 0) {
        await updateCashRegister(null, officer.outlet_id, 'cash_from_recovery', totalAmount, 'add');
    }

    return res.json({ success: true, data: { count: updated.count, message: 'Collections submitted successfully' } });
  } catch (error) {
    console.error('submitCollections error:', error);
    return res.status(500).json({ success: false, error: 'Failed to submit collections' });
  }
};

module.exports = {
  getAllRecoveryOfficers,
  getRecoveryOfficerStats,
  getRecoveryCustomers,
  markPaymentPaid,
  getCollectionStats,
  getDueOverdueInstallments,
  submitCollections
};
