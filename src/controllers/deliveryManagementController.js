const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const axios = require('axios');

const WATI_BASE_URL = process.env.WATI_BASE_URL;
const WATI_ACCESS_TOKEN = process.env.WATI_ACCESS_TOKEN;
const WATI_TEMPLATE_NAME = process.env.WATI_TEMPLATE_NAME;
const WATI_BROADCAST_NAME = process.env.WATI_BROADCAST_NAME;

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

const getDeliveryBoysOverview = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const boys = await prisma.user.findMany({
      where: {
        role: { name: { equals: 'Delivery Agent' } },
        status: 'active'
      },
      select: {
        id: true,
        full_name: true,
        username: true,
        image: true,
        phone: true,
        status: true,
        is_online: true,
        last_known_latitude: true,
        last_known_longitude: true,
        last_online_at: true,
        bike_km_range: true,
        working_hours_start: true,
        working_hours_end: true,
        _count: {
          select: {
            delivery_orders: {
              where: { is_delivered: false }
            }
          }
        },
        delivery_orders: {
          where: {
            updated_at: { gte: today }
          },
          select: {
            status: true
          }
        },
        assigned_orders: {
          where: { status: { in: ['picked', 'in_transit'] } },
          select: {
            id: true,
            status: true,
            order_ref: true,
            customer_name: true,
          },
          take: 1,
        }
      },
      orderBy: { full_name: 'asc' }
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

    const data = boys.map(b => {
      const deliveredToday = b.delivery_orders.filter(o => o.status === 'delivered').length;
      const returnedToday = b.delivery_orders.filter(o => o.status === 'returned').length;

      return {
        id: b.id,
        name: b.full_name,
        username: b.username,
        profile_image: b.image,
        pending_count: b._count.delivery_orders,
        delivered_today: deliveredToday,
        returned_today: returnedToday,
        whatsapp: b.phone || null,
        account_status: b.status,
        is_online: b.is_online,
        last_online_at: b.last_online_at,
        current_location:
          b.is_online && b.last_known_latitude
            ? { latitude: b.last_known_latitude, longitude: b.last_known_longitude }
            : null,
        last_known_location:
          !b.is_online && b.last_known_latitude
            ? {
              latitude: b.last_known_latitude,
              longitude: b.last_known_longitude,
              timestamp: b.last_online_at,
            }
            : null,
        bike_km_range: b.bike_km_range,
        working_hours:
          b.working_hours_start && b.working_hours_end
            ? `${b.working_hours_start} - ${b.working_hours_end}`
            : null,
        current_assignment: b.assigned_orders[0] ? {
          id: b.assigned_orders[0].id,
          status: b.assigned_orders[0].status,
          order: {
            order_ref: b.assigned_orders[0].order_ref,
            customer_name: b.assigned_orders[0].customer_name
          }
        } : null,
        monthly_online_hours: monthlyStatsMap.get(b.id) || '0.00',
      };
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

const getDeliveryBoyStats = async (req, res) => {
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
    console.error('getDeliveryBoyStats error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

// 2. Get details for one delivery boy (profile + grouped pending products)
const getDeliveryBoyDetails = async (req, res) => {
  const { boyId } = req.params;

  try {
    const boy = await prisma.user.findUnique({
      where: { id: Number(boyId) },
      select: {
        id: true,
        full_name: true,
        username: true,
        image: true,
        phone: true,
        status: true,
        is_online: true,
        last_online_at: true,
        last_known_latitude: true,
        last_known_longitude: true,
        bike_km_range: true,
        working_hours_start: true,
        working_hours_end: true
      }
    });

    if (!boy) {
      return res.status(404).json({ success: false, error: 'Delivery boy not found' });
    }

    const orders = await prisma.order.findMany({
      where: {
        delivery_officer_id: boy.id,
        is_delivered: false
      },
      select: {
        product_name: true,
        total_amount: true,
        advance_amount: true,
        monthly_amount: true,
        months: true
      }
    });

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthlyStatsRaw = await prisma.officerSession.groupBy({
      by: ['officer_id'],
      where: {
        officer_id: Number(boyId),
        start_time: { gte: startOfMonth }
      },
      _sum: { duration_minutes: true },
    });

    const monthlyOnlineHours = ((monthlyStatsRaw[0]?._sum.duration_minutes || 0) / 60).toFixed(2);

    // Grouping logic
    const grouped = {};
    orders.forEach(o => {
      const key = (o.product_name || 'Unknown').trim().toLowerCase();
      if (!grouped[key]) {
        grouped[key] = {
          product_name: o.product_name?.trim() || 'Unknown',
          count: 0,
          total_amount: 0,
          advance_amount: 0,
          monthly_amount: 0,
          months: o.months || 0
        };
      }
      const g = grouped[key];
      g.count++;
      g.total_amount += o.total_amount || 0;
      g.advance_amount += o.advance_amount || 0;
      g.monthly_amount += o.monthly_amount || 0;
    });

    const products = Object.values(grouped).map(g => ({
      product_name: g.product_name,
      count: g.count,
      total_amount: Math.round(g.total_amount * 100) / 100,
      advance_amount: Math.round(g.advance_amount * 100) / 100,
      monthly_amount: Math.round(g.monthly_amount * 100) / 100,
      months: g.months
    })).sort((a, b) => b.count - a.count);

    return res.json({
      success: true,
      data: {
        boy: {
          id: boy.id,
          name: boy.full_name,
          username: boy.username,
          profile_image: boy.image,
          whatsapp: boy.phone,
          account_status: boy.status,
          is_online: boy.is_online,
          last_online_at: boy.last_online_at,
          current_location:
            boy.is_online && boy.last_known_latitude
              ? { latitude: boy.last_known_latitude, longitude: boy.last_known_longitude }
              : null,
          last_known_location:
            !boy.is_online && boy.last_known_latitude
              ? {
                latitude: boy.last_known_latitude,
                longitude: boy.last_known_longitude,
                timestamp: boy.last_online_at,
              }
              : null,
          bike_km_range: boy.bike_km_range,
          working_hours:
            boy.working_hours_start && boy.working_hours_end
              ? `${boy.working_hours_start} - ${boy.working_hours_end}`
              : null,
          monthly_online_hours: monthlyOnlineHours
        },
        pending_products: products
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};

// 3. Generate & send OTP to delivery boy for all his pending orders
const generatePickupOtp = async (req, res) => {
  const { deliveryBoyId } = req.body;

  if (!deliveryBoyId) {
    return res.status(400).json({ success: false, error: 'deliveryBoyId required' });
  }

  try {
    const boy = await prisma.user.findUnique({
      where: { id: Number(deliveryBoyId) },
      select: { phone: true }
    });

    if (!boy) return res.status(404).json({ success: false, error: 'Delivery boy not found' });

    const whatsapp = boy.phone;
    if (!whatsapp) {
      return res.status(400).json({ success: false, error: 'No WhatsApp or phone number' });
    }

    const otp = Math.floor(10000 + Math.random() * 90000).toString();
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000); // 20 minutes

    // Find pending orders without OTP
    const pending = await prisma.order.findMany({
      where: {
        delivery_officer_id: Number(deliveryBoyId),
        is_delivered: false,
        pickup_otp: null
      },
      select: { id: true }
    });

    if (pending.length === 0) {
      return res.status(400).json({ success: false, error: 'No pending orders available' });
    }

    const ids = pending.map(o => o.id);

    await prisma.order.updateMany({
      where: { id: { in: ids } },
      data: {
        pickup_otp: otp,
        otp_generated_at: new Date(),
        otp_expires_at: expiresAt
      }
    });

    // Send via WATI
    const url = `${WATI_BASE_URL}/api/v2/sendTemplateMessage?whatsappNumber=+92${whatsapp.slice(1)}`;
    await axios.post(url, {
      template_name: WATI_TEMPLATE_NAME,
      broadcast_name: WATI_BROADCAST_NAME,
      parameters: [{ name: '1', value: otp }]
    }, {
      headers: {
        Authorization: `Bearer ${WATI_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    return res.json({
      success: true,
      message: 'OTP generated and sent via WhatsApp',
      // otp: otp   // ← comment out or remove in production!
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Failed to send OTP' });
  }
};

// 4. Verify OTP and mark orders as picked
const verifyPickupOtp = async (req, res) => {
  const { deliveryBoyId, otp } = req.body;

  if (!deliveryBoyId || !otp || otp.length !== 5) {
    return res.status(400).json({ success: false, error: 'Invalid request' });
  }

  try {
    const orders = await prisma.order.findMany({
      where: {
        delivery_officer_id: Number(deliveryBoyId),
        pickup_otp: otp,
        is_delivered: false,
        otp_expires_at: { gt: new Date() }
      },
      select: { id: true }
    });

    if (orders.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid or expired OTP' });
    }

    const ids = orders.map(o => o.id);

    await prisma.order.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'picked',
        pickup_otp: null,
        otp_generated_at: null,
        otp_expires_at: null
      }
    });

    return res.json({
      success: true,
      message: `${orders.length} orders marked as picked`
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};

module.exports = {
  getDeliveryBoysOverview,
  getDeliveryBoyDetails,
  generatePickupOtp,
  verifyPickupOtp,
  getDeliveryBoyStats
};
