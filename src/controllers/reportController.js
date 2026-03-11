const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const getDateRangeFilter = (range, start, end) => {
  const now = new Date();
  let gte, lt;

  switch (range) {
    case 'Day':
      gte = new Date();
      gte.setHours(0, 0, 0, 0);
      lt = new Date(gte);
      lt.setDate(lt.getDate() + 1);
      break;
    case 'Week':
      gte = new Date();
      gte.setDate(now.getDate() - 7);
      gte.setHours(0, 0, 0, 0);
      lt = new Date(now);
      break;
    case 'Month':
      gte = new Date(now.getFullYear(), now.getMonth(), 1);
      lt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      break;
    case 'Quarter': {
      const currentQuarter = Math.floor(now.getMonth() / 3);
      gte = new Date(now.getFullYear(), currentQuarter * 3, 1);
      lt = new Date(now.getFullYear(), (currentQuarter + 1) * 3, 1);
      break;
    }
    case 'Year':
      gte = new Date(now.getFullYear(), 0, 1);
      lt = new Date(now.getFullYear() + 1, 0, 1);
      break;
    case 'Custom':
      if (start && end) {
        gte = new Date(start);
        lt = new Date(end);
        lt.setDate(lt.getDate() + 1);
      }
      break;
    default:
      return null;
  }

  return { gte, lt };
};

const getReportSummary = async (req, res) => {
  try {
    const {
      dateRange = 'Month',
      startDate,
      endDate,
      status,
      channel,
      city,
    } = req.query;

    const createdFilter = getDateRangeFilter(dateRange, startDate, endDate);

    const baseWhere = {};
    if (createdFilter) {
      baseWhere.created_at = createdFilter;
    }

    if (status) {
      const list = String(status)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length === 1) {
        baseWhere.status = list[0];
      } else if (list.length > 1) {
        baseWhere.status = { in: list };
      }
    }

    if (channel) {
      const list = String(channel)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length === 1) {
        baseWhere.channel = list[0];
      } else if (list.length > 1) {
        baseWhere.channel = { in: list };
      }
    }

    if (city) {
      baseWhere.city = String(city).trim();
    }

    const [
      orderStatusAgg,
      ordersByChannel,
      ordersByCity,
      ordersByDay,
      totalOrders,
      customerCount,
      collectionAgg,
    ] = await Promise.all([
      prisma.order.groupBy({
        by: ['status'],
        _count: { _all: true },
        where: baseWhere,
      }),
      prisma.order.groupBy({
        by: ['channel'],
        _count: { _all: true },
        where: baseWhere,
      }),
      prisma.order.groupBy({
        by: ['city'],
        _count: { _all: true },
        where: baseWhere,
      }),
      prisma.order.groupBy({
        by: ['created_at'],
        _count: { _all: true },
        _sum: { total_amount: true, advance_amount: true },
        where: baseWhere,
      }),
      prisma.order.count({ where: baseWhere }),
      prisma.order.groupBy({
        by: ['whatsapp_number'],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.orderPayment.groupBy({
        by: ['paymentType'],
        _sum: { amount: true },
        where: {
          order: baseWhere,
        },
      }),
    ]);

    const dailyMap = {};
    for (const row of ordersByDay) {
      const dayKey = row.created_at.toISOString().slice(0, 10);
      if (!dailyMap[dayKey]) {
        dailyMap[dayKey] = {
          date: dayKey,
          count: 0,
          totalAmount: 0,
          advanceAmount: 0,
        };
      }
      dailyMap[dayKey].count += row._count._all;
      dailyMap[dayKey].totalAmount += row._sum.total_amount || 0;
      dailyMap[dayKey].advanceAmount += row._sum.advance_amount || 0;
    }

    const dailyTrend = Object.values(dailyMap).sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
    );

    const ordersByStatus = orderStatusAgg.reduce((acc, row) => {
      acc[row.status] = row._count._all;
      return acc;
    }, {});

    const byChannel = ordersByChannel.map((row) => ({
      channel: row.channel || 'Unknown',
      count: row._count._all,
    }));

    const byCity = ordersByCity
      .filter((row) => row.city)
      .map((row) => ({
        city: row.city,
        count: row._count._all,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const totalCustomers = customerCount.length;

    let totalReceived = 0;
    let totalPending = 0;
    if (Array.isArray(collectionAgg) && collectionAgg.length > 0) {
      const advancePaid =
        collectionAgg.find((r) => r.paymentType === 'advance')?._sum.amount || 0;
      const installmentsPaid =
        collectionAgg.find((r) => r.paymentType === 'installment')?._sum.amount || 0;
      totalReceived = advancePaid + installmentsPaid;
    }

    // Simple pending estimate based on orders in range
    const pendingAgg = await prisma.order.aggregate({
      where: baseWhere,
      _sum: {
        total_amount: true,
      },
    });
    const grossAmount = pendingAgg._sum.total_amount || 0;
    totalPending = Math.max(0, grossAmount - totalReceived);

    return res.json({
      success: true,
      data: {
        meta: {
          dateRange,
          startDate: createdFilter?.gte || null,
          endDate: createdFilter?.lt || null,
        },
        overview: {
          totalOrders,
          totalCustomers,
          ordersByStatus,
          totalReceived,
          totalPending,
        },
        breakdown: {
          byChannel,
          byCity,
          dailyTrend,
        },
      },
    });
  } catch (error) {
    console.error('getReportSummary error:', error);
    return res
      .status(500)
      .json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

module.exports = {
  getReportSummary,
};

