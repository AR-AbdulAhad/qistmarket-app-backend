const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient();
const { notifyUser } = require('../utils/notificationUtils');
const { getPKTDate } = require("../utils/dateUtils");

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

async function sendOrderAssignmentNotification(order, user, type, io = null) {
  let title = 'New Order Assigned';
  let message = `Order ${order.order_ref} has been assigned to you.`;
  let notificationType = 'order_assignment';

  if (type === 'verification') {
    title = 'New Order Assigned';
    message = `Order ${order.order_ref} has been assigned to you for verification.`;
    notificationType = 'order_assignment';
  } else if (type === 'delivery') {
    title = 'New Order Assigned for Delivery';
    message = `Order ${order.order_ref} has been assigned to you for Delivery.`;
    notificationType = 'delivery_assignment';
  } else if (type === 'recovery') {
    title = 'New Order Assigned for Recovery';
    message = `Order ${order.order_ref} has been assigned to you for Recovery.`;
    notificationType = 'recovery_assignment';
  } else if (type === 'verification_location') {
    title = 'New Task Assigned for Verification';
    message = `Please verify and capture home location for order ${order.order_ref}.`;
    notificationType = 'order_assignment';
  } else if (type === 'delivery_location') {
    title = 'New Task Assigned for Delivery';
    message = `Please update the delivery location for order ${order.order_ref}.`;
    notificationType = 'delivery_assignment';
  }

  // Save to DB and emit Socket.io
  if (user?.id) {
    await notifyUser(user.id, title, message, notificationType, order.id, io);
  }

  if (!user?.fcm_token) return;

  try {
    await admin.messaging().send({
      token: user.fcm_token,
      notification: { title, body: message },
      data: {
        order_id: order.id.toString(),
        order_ref: order.order_ref,
        type: notificationType,
      },
    });
  } catch (fcmError) {
    console.error('FCM send failed:', fcmError);
  }
}

const expireOrders = async (io = null) => {
  const now = new Date();
  const pendingExpiry = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const inProgressExpiry = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  const pendingOrders = await prisma.order.findMany({
    where: {
      status: 'pending',
      updated_at: { lt: pendingExpiry },
    },
    include: { assigned_to: true },
  });

  const inProgressOrders = await prisma.order.findMany({
    where: {
      status: 'in_progress',
      updated_at: { lt: inProgressExpiry },
    },
    include: { assigned_to: true },
  });

  const ordersToExpire = [...pendingOrders, ...inProgressOrders];
  if (ordersToExpire.length === 0) {
    return { expiredCount: 0 };
  }

  const orderIds = ordersToExpire.map((order) => order.id);
  await prisma.order.updateMany({
    where: { id: { in: orderIds } },
    data: { status: 'expired' },
  });

  for (const order of ordersToExpire) {
    const orderData = {
      id: order.id,
      order_ref: order.order_ref,
      previous_status: order.status,
      updated_at: new Date().toISOString(),
    };

    if (io) {
      if (order.assigned_to?.id) {
        io.to(`user_${order.assigned_to.id}`).emit('order_expired', orderData);
      }
      io.to('admins').emit('order_expired', orderData);
    }

    if (order.assigned_to?.id) {
      await notifyUser(
        order.assigned_to.id,
        'Order Expired',
        `Order ${order.order_ref} has been marked expired due to inactivity.`,
        'order_expired',
        order.id,
        io,
      );
    }
  }

  return { expiredCount: ordersToExpire.length };
};

function getDateRangeFilter(range, start, end) {
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
      lt = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      break;
    case 'Quarter':
      const currentQuarter = Math.floor(now.getMonth() / 3);
      gte = new Date(now.getFullYear(), currentQuarter * 3, 1);
      lt = new Date(now.getFullYear(), (currentQuarter + 1) * 3, 0, 23, 59, 59, 999);
      break;
    case 'Year':
      gte = new Date(now.getFullYear(), 0, 1);
      lt = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
      break;
    case 'Custom Range':
      if (start && end) {
        gte = new Date(start);
        lt = new Date(end);
        lt.setHours(23, 59, 59, 999);
      }
      break;
    default:
      return null;
  }
  return { gte, lt };
}

const createOrder = async (req, res) => {
  const {
    customer_name,
    whatsapp_number,
    alternate_contact,
    address,
    city,
    area,
    product_name,
    total_amount,
    advance_amount,
    monthly_amount,
    months,
    channel,
    gender,
    marital_status,
    residential_type,
    zone,
    block,
    street,
    house_no,
    order_notes,
  } = req.body;

  if (!customer_name || !whatsapp_number || !address || !product_name ||
    !total_amount || !advance_amount || !monthly_amount || !months || !channel) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Required fields are missing.' }
    });
  }

  const validGenders = ['Male', 'Female', 'Unidentified'];
  const validMaritalStatuses = ['Single', 'Married', 'Divorced', 'Widowed'];
  const validResidentialTypes = ['Own', 'Rented', 'With Family'];

  if (gender && !validGenders.includes(gender)) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: `Invalid gender. Allowed: ${validGenders.join(', ')}` }
    });
  }

  if (marital_status && !validMaritalStatuses.includes(marital_status)) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: `Invalid marital status. Allowed: ${validMaritalStatuses.join(', ')}` }
    });
  }

  if (residential_type && !validResidentialTypes.includes(residential_type)) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: `Invalid residential type. Allowed: ${validResidentialTypes.join(', ')}` }
    });
  }

  try {
    const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const existingOrders = await prisma.order.findMany({
      where: {
        OR: [
          { whatsapp_number: whatsapp_number.trim() },
        ],
        created_at: { gte: today, lt: tomorrow },
        status: { notIn: ['cancelled', 'delivered'] }
      },
      select: { id: true, whatsapp_number: true, status: true }
    });

    const sameDayDuplicate = existingOrders.find(
      o => o.whatsapp_number === whatsapp_number.trim()
        && o.product_name?.toLowerCase() === product_name.trim().toLowerCase()
    );

    if (sameDayDuplicate) {
      return res.status(409).json({
        success: false,
        error: {
          code: 409,
          message: 'Duplicate active order detected today for this customer and product.'
        }
      });
    }

    const activeOrderCount = await prisma.order.count({
      where: {
        whatsapp_number: whatsapp_number.trim(),
        status: { notIn: ['cancelled', 'delivered'] }
      }
    });

    if (activeOrderCount >= 2) {
      return res.status(409).json({
        success: false,
        error: {
          code: 409,
          message: 'Customer already has 2 or more active orders. Maximum 2 active accounts allowed.'
        }
      });
    }

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const order_ref = `QIST-${dateStr}-${randomNum}`;

    const token_number = crypto.randomBytes(4).toString('hex').toUpperCase();

    // Auto-assignment logic
    let assignedOfficerId = null;
    if (zone && area) {
      const assignment = await prisma.officerAreaAssignment.findFirst({
        where: {
          zone: zone.trim(),
          area: area.trim()
        },
        select: { user_id: true }
      });
      if (assignment) {
        assignedOfficerId = assignment.user_id;
      }
    }

    const order = await prisma.order.create({
      data: {
        order_ref,
        token_number,
        customer_name: customer_name.trim(),
        whatsapp_number: whatsapp_number.trim(),
        alternate_contact: alternate_contact ? alternate_contact.trim() : null,
        address: address.trim(),
        city: city ? city.trim() : null,
        area: area ? area.trim() : null,
        zone: zone ? zone.trim() : null,
        block: block ? block.trim() : null,
        street: street ? street.trim() : null,
        house_no: house_no ? house_no.trim() : null,
        order_notes: order_notes ? order_notes.trim() : null,

        gender: gender || null,
        marital_status: marital_status || null,
        residential_type: residential_type || null,

        product_name: product_name.trim(),
        total_amount: parseFloat(total_amount),
        advance_amount: parseFloat(advance_amount),
        monthly_amount: parseFloat(monthly_amount),
        months: parseInt(months),
        channel: channel.trim(),
        status: assignedOfficerId ? 'pending' : 'new',
        created_at: getPKTDate(new Date()),
        created_by_user_id: req.user.id,
        outlet_id: currentUser?.outlet_id || null,
        assigned_to_user_id: assignedOfficerId
      },
      include: {
        created_by: { select: { username: true } },
        assigned_to: { select: { id: true, username: true, fcm_token: true } }
      }
    });

    if (assignedOfficerId) {
      // Send notification
      const io = req.app.get('io');
      await sendOrderAssignmentNotification(order, order.assigned_to, 'verification', io);
    }

    return res.status(201).json({
      success: true,
      message: 'Order created successfully.',
      data: {
        order: {
          id: order.id,
          order_ref: order.order_ref,
          token_number: order.token_number,
          status: order.status,
          customer_name: order.customer_name,
          whatsapp_number: order.whatsapp_number,
          alternate_contact: order.alternate_contact,
          address: order.address,
          city: order.city,
          area: order.area,
          zone: order.zone,
          block: order.block,
          street: order.street,
          house_no: order.house_no,
          order_notes: order.order_notes,

          gender: order.gender,
          marital_status: order.marital_status,
          residential_type: order.residential_type,

          product_name: order.product_name,
          total_amount: order.total_amount,
          advance_amount: order.advance_amount,
          monthly_amount: order.monthly_amount,
          months: order.months,
          channel: order.channel,
          created_at: order.created_at,
          created_by: order.created_by?.username || null
        }
      }
    });
  } catch (error) {
    console.error('Create order error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

const getOrders = async (req, res) => {
  const { page = 1, limit = 10, search = '', sortBy = 'created_at', sortDir = 'desc', ...filters } = req.query;

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    const userFromDb = await prisma.user.findUnique({ where: { id: req.user.id } });
    const where = {};
    const userRole = (req.user?.role || '').toLowerCase();

    console.log(userRole);

    if (userRole === 'branch user') {
      where.AND = [
        {
          OR: [
            { outlet_id: userFromDb?.outlet_id || -1 },
            { created_by_user_id: req.user.id }
          ]
        }
      ];
    }

    if (search.trim()) {
      where.OR = [
        { customer_name: { contains: search } },
        { whatsapp_number: { contains: search } },
        { order_ref: { contains: search } },
        { token_number: { contains: search } },
        { product_name: { contains: search } },
        { city: { contains: search } },
        { area: { contains: search } },
      ];
    }

    Object.entries(filters).forEach(([key, value]) => {
      if (value) {
        if (key === 'assigned_to') {
          where.assigned_to = { username: { contains: value } };
        } else if (key === 'created_by') {
          where.created_by = { username: { contains: value } };
        } else if (key === 'status') {
          const statusList = value.split(',').map(s => s.trim());
          if (statusList.length > 1) {
            where.status = { in: statusList };
          } else {
            where.status = { contains: value };
          }
        } else if (key === 'dateRange') {
          const range = getDateRangeFilter(value, filters.startDate, filters.endDate);
          if (range) {
            where.created_at = range;
          }
        } else if (key !== 'startDate' && key !== 'endDate') {
          where[key] = { contains: value };
        }
      }
    });

    const include = {
      created_by: { select: { username: true } },
      assigned_to: { select: { username: true } },
      productHistories: {
        include: {
          changed_by: { select: { username: true, full_name: true } }
        },
        orderBy: { changed_at: 'desc' }
      }
    };

    const orders = await prisma.order.findMany({
      where,
      skip,
      take,
      orderBy: { [sortBy]: sortDir },
      include,
    });

    const total = await prisma.order.count({ where });

    return res.status(200).json({
      success: true,
      data: {
        orders,
        pagination: {
          page: Number(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNext: skip + take < total,
          hasPrev: Number(page) > 1,
        },
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const getOrdersWithPagination = async (req, res) => {
  const { lastId = 0, limit = 10, search = '', ...filters } = req.query;

  const take = Number(limit);
  const cursorId = Number(lastId);

  try {
    const userFromDb = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { role: true }
    });
    const baseWhere = {};
    const userRole = (req.user?.role || '').toLowerCase();

    if (userRole === 'outlet') {
      baseWhere.AND = [
        {
          OR: [
            { outlet_id: userFromDb?.outlet_id || -1 },
            { created_by_user_id: req.user.id }
          ]
        }
      ];
    }

    if (search.trim()) {
      baseWhere.OR = [
        { customer_name: { contains: search } },
        { whatsapp_number: { contains: search } },
        { order_ref: { contains: search } },
        { token_number: { contains: search } },
        { product_name: { contains: search } },
        { city: { contains: search } },
        { area: { contains: search } },
      ];
    }

    Object.entries(filters).forEach(([key, value]) => {
      if (value) {
        if (key === 'assigned_to') {
          baseWhere.assigned_to = { username: value };
        } else if (key === 'created_by') {
          baseWhere.created_by = { username: value };
        } else if (key === 'status') {
          const statusList = value.split(',').map(s => s.trim());
          if (statusList.length > 1) {
            baseWhere.status = { in: statusList };
          } else {
            baseWhere.status = value;
          }
        } else if (key === 'channel') {
          const channelList = value.split(',').map(s => s.trim());
          if (channelList.length > 1) {
            baseWhere.channel = { in: channelList };
          } else {
            baseWhere.channel = value;
          }
        } else if (key === 'dateRange') {
          const range = getDateRangeFilter(value, filters.startDate, filters.endDate);
          if (range) {
            baseWhere.created_at = range;
          }
        } else if (key !== 'startDate' && key !== 'endDate') {
          baseWhere[key] = { contains: value };
        }
      }
    });

    const totalCount = await prisma.order.count({
      where: baseWhere
    });

    const where = { ...baseWhere };
    if (cursorId > 0) {
      where.id = { lt: cursorId };
    }

    const orders = await prisma.order.findMany({
      where,
      take,
      orderBy: { id: 'desc' },
      include: {
        created_by: { select: { username: true } },
        assigned_to: { select: { username: true } },
        productHistories: {
          include: {
            changed_by: { select: { username: true, full_name: true } }
          },
          orderBy: { changed_at: 'desc' }
        }
      },
    });

    let nextLastId = null;
    if (orders.length > 0) {
      nextLastId = orders[orders.length - 1].id;
    }

    const hasMore = orders.length === take;

    return res.status(200).json({
      success: true,
      data: {
        orders,
        pagination: {
          nextLastId,
          hasMore,
          limit: take,
          count: orders.length,
          totalCount
        },
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const takeOrder = async (req, res) => {
  const { id } = req.params;

  try {
    const order = await prisma.order.findUnique({
      where: { id: Number(id) },
    });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.channel !== 'website' && order.channel !== 'Website') {
      return res.status(400).json({ success: false, message: 'Only website orders can be taken here' });
    }

    if (order.status !== 'new' && order.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Order cannot be taken in its current status' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: Number(id) },
      data: {
        assigned_to_user_id: req.user.id,
        status: 'pending',
      },
      include: {
        assigned_to: { select: { id: true, username: true } },
      },
    });

    return res.status(200).json({
      success: true,
      message: 'Website order taken successfully',
      data: { order: updatedOrder },
    });
  } catch (error) {
    console.error('takeOrder error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getCsrDashboardStats = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [totalToday, websitePending, repeatCustomerGroups, clearAccountsCount, statusCounts] = await Promise.all([
      prisma.order.count({
        where: {
          created_at: { gte: today, lt: tomorrow },
        },
      }),
      prisma.order.count({
        where: {
          channel: { in: ['website', 'Website'] },
          status: { in: ['new', 'pending'] },
        },
      }),
      prisma.order.groupBy({
        by: ['whatsapp_number'],
        where: {
          created_at: { gte: today, lt: tomorrow },
          whatsapp_number: { not: '' },
        },
        _count: { whatsapp_number: true },
      }),
      prisma.order.count({
        where: {
          status: { in: ['delivered', 'completed'] },
        }
      }),
      prisma.order.groupBy({
        by: ['status'],
        _count: { id: true },
      }),
    ]);

    const [dailySalesSum, weeklySalesSum, monthlySalesSum] = await Promise.all([
      prisma.order.aggregate({
        _sum: { total_amount: true },
        where: {
          created_at: { gte: today, lt: tomorrow },
          status: { not: 'cancelled' },
        },
      }),
      prisma.order.aggregate({
        _sum: { total_amount: true },
        where: {
          created_at: { gte: new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6), lt: tomorrow },
          status: { not: 'cancelled' },
        },
      }),
      prisma.order.aggregate({
        _sum: { total_amount: true },
        where: {
          created_at: { gte: new Date(today.getFullYear(), today.getMonth(), 1), lt: tomorrow },
          status: { not: 'cancelled' },
        },
      }),
    ]);

    const repeatCustomers = repeatCustomerGroups.filter(group => group._count.whatsapp_number > 1).length;
    const statuses = statusCounts.reduce((acc, item) => {
      acc[item.status] = item._count.id;
      return acc;
    }, {});

    const dailySales = dailySalesSum._sum.total_amount || 0;
    const weeklySales = weeklySalesSum._sum.total_amount || 0;
    const monthlySales = monthlySalesSum._sum.total_amount || 0;
    const target = Number(process.env.CSR_SALES_TARGET || 0);
    const remainingTarget = target > 0 ? Math.max(0, target - dailySales) : 0;

    return res.status(200).json({
      success: true,
      data: {
        totalOrdersToday: totalToday,
        websiteOrdersPending: websitePending,
        repeatCustomersToday: repeatCustomers,
        clearAccountsCount,
        statusCounts: {
          new: statuses.new || 0,
          pending: statuses.pending || 0,
          in_progress: statuses.in_progress || 0,
          expired: statuses.expired || 0,
          picked: statuses.picked || 0,
          delivered: statuses.delivered || 0,
          cancelled: statuses.cancelled || 0,
          approved: statuses.approved || 0,
        },
        dailySales,
        weeklySales,
        monthlySales,
        remainingTarget,
      },
    });
  } catch (error) {
    console.error('getCsrDashboardStats error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getExpiredAssignedOrders = async (req, res) => {
  const userRole = (req.user.role || '').toLowerCase();
  const isVerificationOfficer = req.user.role_id === 1 || userRole.includes('verification');

  if (!isVerificationOfficer) {
    return res.status(403).json({ success: false, message: 'Access denied. Verification officers only.' });
  }

  const page = Number(req.query.page || 1);
  const limit = Number(req.query.limit || 20);
  const skip = (page - 1) * limit;

  try {
    const where = {
      assigned_to_user_id: req.user.id,
      status: 'expired',
    };

    const total = await prisma.order.count({ where });
    const orders = await prisma.order.findMany({
      where,
      orderBy: { updated_at: 'desc' },
      skip,
      take: limit,
    });

    return res.json({
      success: true,
      data: {
        orders,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 1,
        },
      },
    });
  } catch (error) {
    console.error('getExpiredAssignedOrders error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getMyDeliveryOrdersWithPagination = async (req, res) => {
  const { lastId = 0, limit = 10, search = '', ...filters } = req.query;

  const take = Number(limit);
  const cursorId = Number(lastId);

  try {
    const baseWhere = {
      delivery_officer_id: req.user.id,
    };

    if (search.trim()) {
      baseWhere.OR = [
        { customer_name: { contains: search } },
        { whatsapp_number: { contains: search } },
        { order_ref: { contains: search } },
        { token_number: { contains: search } },
        { product_name: { contains: search } },
        { city: { contains: search } },
        { area: { contains: search } },
      ];
    }

    // Optional extra filters (agar frontend se bheje ja rahe hon)
    Object.entries(filters).forEach(([key, value]) => {
      if (value) {
        if (key === 'status') {
          baseWhere.status = value;
        } else if (key === 'created_by') {
          baseWhere.created_by = { username: value };
        } else {
          baseWhere[key] = { contains: value };
        }
      }
    });

    const totalCount = await prisma.order.count({
      where: baseWhere
    });

    const where = { ...baseWhere };
    if (cursorId > 0) {
      where.id = { lt: cursorId };
    }

    const orders = await prisma.order.findMany({
      where,
      take,
      orderBy: { id: 'desc' },
      include: {
        created_by: {
          select: {
            username: true,
            full_name: true,
          },
        },
        assigned_to: {
          select: {
            username: true,
            full_name: true,
          },
        },
        delivery_officer: {
          select: {
            username: true,
            full_name: true,
          },
        },
        verification: {
          select: {
            id: true,
            status: true,
            start_time: true,
            end_time: true,
            purchaser: {
              select: {
                id: true,
                name: true,
                father_husband_name: true,
                present_address: true,
                permanent_address: true,
                utility_bill_url: true,
                cnic_number: true,
                cnic_front_url: true,
                cnic_back_url: true,
                telephone_number: true,
                employer_name: true,
                employer_address: true,
                designation: true,
                official_number: true,
                service_card_url: true,
                years_in_company: true,
                gross_salary: true,
                signature_url: true,
                nearest_location: true,
                is_verified: true,
              },
            },
          },
        },
      },
    });

    let nextLastId = null;
    if (orders.length > 0) {
      nextLastId = orders[orders.length - 1].id;
    }

    const hasMore = orders.length === take;

    return res.status(200).json({
      success: true,
      data: {
        orders,
        pagination: {
          nextLastId,
          hasMore,
          limit: take,
          count: orders.length,
          totalCount
        },
      },
    });
  } catch (error) {
    console.error('getMyDeliveryOrdersWithPagination error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const getOrderById = async (req, res) => {
  const { id } = req.params;
  console.log('Fetching order with ID:', id);

  try {

    // Fetch order and related verification (for purchaser location status)
    const order = await prisma.order.findUnique({
      where: { id: Number(id) },
      include: {
        created_by: { select: { username: true } },
        assigned_to: { select: { username: true } },
        productHistories: {
          include: {
            changed_by: { select: { username: true, full_name: true } }
          },
          orderBy: { changed_at: 'desc' }
        },
        verification: {
          select: {
            id: true,
            status: true,
            home_location_verified: true,
            home_location_required: true,
            purchaser: {
              select: {
                id: true,
                is_verified: true,
              }
            }
          }
        }
      },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Order not found' },
      });
    }

    // Attach purchaser location status if available
    let purchaserLocationStatus = null;
    let purchaserLocationVerified = null;
    if (order.verification && order.verification.purchaser) {
      purchaserLocationStatus = order.verification.purchaser.nearest_location || null;
      purchaserLocationVerified = !!order.verification.purchaser.is_verified;
    }

    return res.status(200).json({
      success: true,
      data: {
        order,
        purchaserLocationStatus,
        purchaserLocationVerified
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const assignOrder = async (req, res) => {
  const { id } = req.params;
  const { user_id, action = 'assign' } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(id) },
      include: {
        assigned_to: { select: { username: true, fcm_token: true } },
      },
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (action === 'unassign') {
      if (!order.assigned_to_user_id) {
        return res.status(400).json({ success: false, message: 'Order is not assigned' });
      }

      const updated = await prisma.order.update({
        where: { id: parseInt(id) },
        data: { assigned_to_user_id: null },
        include: {
          created_by: { select: { username: true } },
          assigned_to: { select: { username: true } },
        },
      });

      return res.status(200).json({
        success: true,
        message: 'Order unassigned successfully',
        data: { order: updated },
      });
    }

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'User ID required for assignment' });
    }

    if (order.assigned_to_user_id) {
      return res.status(409).json({ success: false, message: 'Order is already assigned' });
    }

    const user = await prisma.user.findUnique({
      where: { id: parseInt(user_id) },
      include: { role: true },
    });

    if (!user || user.role.name !== 'Verification Officer') {
      return res.status(400).json({ success: false, message: 'Invalid Verification Officer' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: parseInt(id) },
      data: {
        assigned_to_user_id: parseInt(user_id),
        status: 'pending'
      },
      include: {
        assigned_to: { select: { id: true, username: true, fcm_token: true } },
        created_by: { select: { username: true } },
      },
    });

    const io = req.app.get('io');
    await sendOrderAssignmentNotification(updatedOrder, updatedOrder.assigned_to, 'verification', io);

    return res.status(200).json({
      success: true,
      message: 'Order assigned successfully',
      data: { order: updatedOrder },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const assignBulk = async (req, res) => {
  const { order_ids, user_id, action = 'assign' } = req.body;

  if (!Array.isArray(order_ids) || order_ids.length === 0) {
    return res.status(400).json({ success: false, message: 'order_ids array is required' });
  }

  try {
    if (action === 'unassign') {
      await prisma.order.updateMany({
        where: {
          id: { in: order_ids.map(Number) },
          assigned_to_user_id: { not: null },
        },
        data: { assigned_to_user_id: null },
      });

      return res.status(200).json({
        success: true,
        message: 'Selected orders have been unassigned',
      });
    }

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'user_id required for assignment' });
    }

    const user = await prisma.user.findUnique({
      where: { id: parseInt(user_id) },
      include: { role: true },
    });

    if (!user || user.role.name !== 'Verification Officer') {
      return res.status(400).json({ success: false, message: 'Invalid Verification Officer' });
    }

    const verificationEntries = order_ids.map(id => ({
      order_id: parseInt(id),
      verification_officer_id: parseInt(user_id),
      status: 'in_progress',
      start_time: new Date()
    }));

    await prisma.$transaction([
      prisma.order.updateMany({
        where: { id: { in: order_ids.map(Number) } },
        data: {
          assigned_to_user_id: parseInt(user_id),
          status: 'pending'
        }
      }),
      prisma.verification.createMany({
        data: verificationEntries,
        skipDuplicates: true
      })
    ]);

    // Send notifications for bulk assignment
    const io = req.app.get('io');
    const updatedOrders = await prisma.order.findMany({
      where: { id: { in: order_ids.map(Number) } },
      include: { assigned_to: { select: { id: true, username: true, fcm_token: true } } }
    });

    for (const order of updatedOrders) {
      if (order.assigned_to) {
        await sendOrderAssignmentNotification(order, order.assigned_to, 'verification', io);
      }
    }

    return res.status(200).json({
      success: true,
      message: `${order_ids.length} orders assigned successfully`,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getVerificationOrders = async (req, res) => {
  const { page = 1, limit = 10, search = '', sortBy = 'created_at', sortDir = 'desc', ...filters } = req.query;

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    const where = {
      status: 'completed',
    };

    if (search.trim()) {
      where.OR = [
        { customer_name: { contains: search } },
        { whatsapp_number: { contains: search } },
        { order_ref: { contains: search } },
      ];
    }

    const [orders, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
        include: {
          created_by: { select: { username: true, full_name: true } },
          assigned_to: { select: { username: true, full_name: true } },
          verification: {
            include: {
              verification_officer: { select: { username: true, full_name: true } }
            }
          }
        },
      }),
      prisma.order.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        orders,
        pagination: {
          page: Number(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNext: skip + take < total,
          hasPrev: Number(page) > 1,
        },
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getApprovedOrders = async (req, res) => {
  const { page = 1, limit = 10, search = '' } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    const userFromDb = await prisma.user.findUnique({ where: { id: req.user.id } });
    const userRole = (req.user?.role || '').toLowerCase();

    const where = {
      status: { in: ['picked', 'approved'] },
    };

    if (userRole === 'branch user') {
      where.AND = [
        {
          OR: [
            { outlet_id: userFromDb?.outlet_id || -1 },
            { created_by_user_id: req.user.id }
          ]
        }
      ];
    }

    if (search.trim()) {
      where.OR = [
        { customer_name: { contains: search } },
        { whatsapp_number: { contains: search } },
        { order_ref: { contains: search } },
      ];
    }

    const [orders, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        skip,
        take,
        orderBy: { updated_at: 'desc' },
        include: {
          verification: {
            include: {
              verification_officer: {
                select: { full_name: true, username: true }
              }
            }
          },
          created_by: {
            select: { id: true, full_name: true, username: true }
          },
          assigned_to: {
            select: { id: true, full_name: true, username: true }
          },
          delivery_officer: {
            select: {
              id: true,
              username: true,
              full_name: true
            }
          }
        }
      }),
      prisma.order.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        orders,
        pagination: {
          page: Number(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNext: skip + take < total,
          hasPrev: Number(page) > 1,
        },
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const assignDelivery = async (req, res) => {
  const { id } = req.params;
  const { user_id, action = 'assign' } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: Number(id) },
      include: { verification: true }
    });

    if (!order || order.verification?.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Order not found or not approved' });
    }

    if (action === 'unassign') {
      const updatedOrder = await prisma.order.update({
        where: { id: Number(id) },
        data: {
          delivery_officer_id: null,
          outlet_id: null, // Also unassign from outlet
          status: 'approved'
        },
        include: {
          delivery_officer: { select: { username: true } }
        }
      });

      return res.status(200).json({
        success: true,
        message: 'Delivery officer unassigned successfully',
        data: { order: updatedOrder }
      });
    }

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'delivery_officer_id (user_id) required' });
    }

    // Connect to specific Outlet based on delivery officer
    const officer = await prisma.user.findUnique({
      where: { id: Number(user_id) },
      select: { outlet_id: true }
    });

    const updatedOrder = await prisma.order.update({
      where: { id: Number(id) },
      data: {
        delivery_officer_id: Number(user_id),
        outlet_id: officer?.outlet_id || null, // Connects order to the outlet
        status: 'approved' // Assignment starts from approved (ready for outlet handover)
      },
      include: {
        delivery_officer: { select: { id: true, username: true, fcm_token: true, full_name: true } }
      }
    });

    // Send notification
    const io = req.app.get('io');
    if (updatedOrder.delivery_officer) {
      await sendOrderAssignmentNotification(updatedOrder, updatedOrder.delivery_officer, 'delivery', io);
    }

    return res.status(200).json({
      success: true,
      message: 'Delivery officer assigned successfully',
      data: { order: updatedOrder }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const assignBulkDelivery = async (req, res) => {
  const { order_ids, user_id, action = 'assign' } = req.body;

  if (!Array.isArray(order_ids) || order_ids.length === 0) {
    return res.status(400).json({ success: false, message: 'order_ids required' });
  }

  try {
    if (action === 'unassign') {
      await prisma.order.updateMany({
        where: { id: { in: order_ids.map(Number) } },
        data: {
          delivery_officer_id: null,
          outlet_id: null, // Also unassign from outlet
          status: 'approved'
        }
      });
      return res.status(200).json({
        success: true,
        message: `${order_ids.length} orders unassigned from delivery`
      });
    }

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'user_id required' });
    }

    // Get the officer's outlet ID
    const officer = await prisma.user.findUnique({
      where: { id: Number(user_id) },
      select: { outlet_id: true }
    });

    await prisma.order.updateMany({
      where: { id: { in: order_ids.map(Number) } },
      data: {
        delivery_officer_id: Number(user_id),
        outlet_id: officer?.outlet_id || null, // Connects order to the outlet
        status: 'approved'
      }
    });

    // Send notifications for bulk delivery assignment
    const io = req.app.get('io');
    const updatedOrders = await prisma.order.findMany({
      where: { id: { in: order_ids.map(Number) } },
      include: { delivery_officer: { select: { id: true, username: true, fcm_token: true, full_name: true } } }
    });

    for (const order of updatedOrders) {
      if (order.delivery_officer) {
        await sendOrderAssignmentNotification(order, order.delivery_officer, 'delivery', io);
      }
    }

    return res.status(200).json({
      success: true,
      message: `${order_ids.length} orders assigned for delivery`
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const cancelOrder = async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  try {
    const updatedOrder = await prisma.order.update({
      where: { id: parseInt(id) },
      data: {
        status: 'cancelled',
        cancelled_at: new Date(),
        cancelled_reason: reason || 'Cancelled by admin',
      },
    });

    return res.status(200).json({
      success: true,
      message: 'Order cancelled successfully',
      data: { order: updatedOrder },
    });
  } catch (error) {
    console.error('Cancel order error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const updateOrderItem = async (req, res) => {
  const { id } = req.params;
  const { product_name, total_amount, advance_amount, monthly_amount, months } = req.body;

  try {
    const order = await prisma.order.findUnique({ where: { id: parseInt(id) } });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const updatedOrder = await prisma.$transaction(async (tx) => {
      if (product_name && product_name !== order.product_name) {
        await tx.orderProductHistory.create({
          data: {
            order_id: order.id,
            previous_product: order.product_name,
            current_product: product_name,
            changed_by_user_id: req.user.id,
          },
        });
      }

      return tx.order.update({
        where: { id: parseInt(id) },
        data: {
          product_name,
          total_amount: total_amount ? parseFloat(total_amount) : undefined,
          advance_amount: advance_amount ? parseFloat(advance_amount) : undefined,
          monthly_amount: monthly_amount ? parseFloat(monthly_amount) : undefined,
          months: months ? parseInt(months) : undefined,
        },
      });
    });

    return res.status(200).json({
      success: true,
      message: 'Order item updated successfully',
      data: { order: updatedOrder },
    });
  } catch (error) {
    console.error('Update order item error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getDeliveryStatus = async (req, res) => {
  try {
    const counts = await prisma.order.groupBy({
      by: ['status'],
      _count: { id: true },
    });

    const stats = {
      pending: 0,
      approved: 0,
      picked: 0,
      delivered: 0,
      cancelled: 0,
    };

    counts.forEach((c) => {
      if (stats.hasOwnProperty(c.status)) {
        stats[c.status] = c._count.id;
      }
    });

    return res.status(200).json({ success: true, data: stats });
  } catch (error) {
    console.error('Get delivery status error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getDeliveredOrders = async (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    const orders = await prisma.order.findMany({
      where: { status: 'delivered' },
      skip,
      take,
      orderBy: { updated_at: 'desc' },
      include: {
        created_by: { select: { username: true } },
        delivery_officer: { select: { username: true, full_name: true } },
      },
    });

    const total = await prisma.order.count({ where: { status: 'delivered' } });

    return res.status(200).json({
      success: true,
      data: {
        orders,
        pagination: {
          page: Number(page),
          total,
          totalPages: Math.ceil(total / take),
        },
      },
    });
  } catch (error) {
    console.error('Get delivered orders error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const assignRecovery = async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;

  try {
    const updatedOrder = await prisma.order.update({
      where: { id: parseInt(id) },
      data: { recovery_officer_id: parseInt(user_id) },
      include: {
        recovery_officer: { select: { id: true, username: true, fcm_token: true, full_name: true } }
      }
    });

    // Send notification
    const io = req.app.get('io');
    if (updatedOrder.recovery_officer) {
      await sendOrderAssignmentNotification(updatedOrder, updatedOrder.recovery_officer, 'recovery', io);
    }

    return res.status(200).json({
      success: true,
      message: 'Recovery officer assigned successfully',
      data: { order: updatedOrder },
    });
  } catch (error) {
    console.error('Assign recovery error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const assignBulkRecovery = async (req, res) => {
  const { order_ids, user_id } = req.body;

  try {
    await prisma.order.updateMany({
      where: { id: { in: order_ids.map(Number) } },
      data: { recovery_officer_id: parseInt(user_id) },
    });

    // Send notifications for bulk recovery assignment
    const io = req.app.get('io');
    const updatedOrders = await prisma.order.findMany({
      where: { id: { in: order_ids.map(Number) } },
      include: { recovery_officer: { select: { id: true, username: true, fcm_token: true, full_name: true } } }
    });

    for (const order of updatedOrders) {
      if (order.recovery_officer) {
        await sendOrderAssignmentNotification(order, order.recovery_officer, 'recovery', io);
      }
    }

    return res.status(200).json({
      success: true,
      message: `${order_ids.length} orders assigned for recovery`,
    });
  } catch (error) {
    console.error('Assign bulk recovery error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const initiateHandover = async (req, res) => {
  const { id } = req.params; // Order ID
  const { saveOTP } = require('../utils/otpUtils');
  const axios = require('axios');

  try {
    const order = await prisma.order.findUnique({
      where: { id: Number(id) },
      include: { delivery_officer: true }
    });

    if (!order || order.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Order must be in APPROVED status for handover' });
    }

    if (!order.delivery_officer || !order.delivery_officer.phone) {
      return res.status(400).json({ success: false, message: 'No delivery officer assigned or phone missing' });
    }

    const otp = await saveOTP(order.delivery_officer.phone, 'handover');

    // Send via WATI
    const WATI_BASE_URL = process.env.WATI_BASE_URL;
    const WATI_ACCESS_TOKEN = process.env.WATI_ACCESS_TOKEN;
    const WATI_TEMPLATE_NAME = process.env.WATI_TEMPLATE_NAME;

    if (WATI_BASE_URL && WATI_ACCESS_TOKEN) {
      const url = `${WATI_BASE_URL}/api/v2/sendTemplateMessage?whatsappNumber=+92${order.delivery_officer.phone.slice(1)}`;
      try {
        await axios.post(url, {
          template_name: WATI_TEMPLATE_NAME || 'otp_verification',
          broadcast_name: 'Handover_OTP',
          parameters: [{ name: '1', value: otp }]
        }, {
          headers: {
            Authorization: `Bearer ${WATI_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
      } catch (watiErr) {
        console.error('WATI Error details:', watiErr.response?.data || watiErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Handover OTP initiated',
      otp: process.env.NODE_ENV === 'development' ? otp : undefined
    });
  } catch (error) {
    console.error('initiateHandover error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const verifyHandover = async (req, res) => {
  const { id } = req.params; // Order ID
  const { otp, imei_serial } = req.body;
  const { verifyOTP } = require('../utils/otpUtils');

  try {
    const order = await prisma.order.findUnique({
      where: { id: Number(id) },
      include: { delivery_officer: true }
    });

    if (!order || order.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Order must be in APPROVED status for handover' });
    }

    // Verify OTP
    const otpResult = await verifyOTP(order.delivery_officer.phone, otp, 'handover');
    if (!otpResult.valid) {
      return res.status(400).json({ success: false, message: otpResult.message });
    }

    // Check IMEI in inventory
    const inventoryItem = await prisma.outletInventory.findUnique({
      where: { imei_serial }
    });

    if (!inventoryItem || inventoryItem.status !== 'In Stock') {
      return res.status(400).json({ success: false, message: 'IMEI not found or not in stock' });
    }

    if (inventoryItem.outlet_id !== req.user.outlet_id) {
      return res.status(400).json({ success: false, message: 'This item does not belong to your outlet' });
    }

    // Atomic update
    await prisma.$transaction([
      prisma.order.update({
        where: { id: order.id },
        data: {
          status: 'picked',
          imei_serial: imei_serial,
        }
      }),
      prisma.outletInventory.update({
        where: { id: inventoryItem.id },
        data: { status: 'Sold' }
      }),
      prisma.stockTransfer.create({
        data: {
          from_type: 'Outlet',
          from_id: order.outlet_id || 0,
          to_type: 'Delivery Officer',
          to_id: order.delivery_officer_id || 0,
          inventory_id: inventoryItem.id
        }
      })
    ]);

    return res.status(200).json({
      success: true,
      message: 'Stock handover verified and completed'
    });
  } catch (error) {
    console.error('verifyHandover error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getOutletDeliveryOfficers = async (req, res) => {
  try {
    const outlet_id = req.user.outlet_id;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Forbidden: No outlet assigned' });

    const officers = await prisma.user.findMany({
      where: {
        outlet_id: outlet_id,
        role: { name: 'Delivery Agent' },
        status: 'active'
      },
      select: {
        id: true,
        full_name: true,
        username: true,
        phone: true,
        is_online: true,
        image: true
      }
    });

    return res.status(200).json({ success: true, data: officers });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getOfficerApprovedOrders = async (req, res) => {
  const { officerId } = req.params;
  try {
    const orders = await prisma.order.findMany({
      where: {
        delivery_officer_id: Number(officerId),
        status: 'approved',
        outlet_id: req.user.outlet_id
      },
      orderBy: { created_at: 'desc' }
    });

    return res.status(200).json({ success: true, data: orders });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getHandoverHistory = async (req, res) => {
  try {
    const outlet_id = req.user.outlet_id;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Forbidden' });

    const transfers = await prisma.stockTransfer.findMany({
      where: {
        from_type: 'Outlet',
        from_id: outlet_id
      },
      include: {
        inventory: {
          select: {
            imei_serial: true,
            product_name: true
          }
        }
      },
      orderBy: { created_at: 'desc' },
      take: 100
    });

    const imeis = transfers.map(t => t.inventory.imei_serial);
    const orders = await prisma.order.findMany({
      where: { imei_serial: { in: imeis } },
      select: {
        imei_serial: true,
        customer_name: true,
        order_ref: true,
        delivery_officer: { select: { full_name: true } }
      }
    });

    const orderMap = new Map(orders.map(o => [o.imei_serial, o]));

    const data = transfers.map(t => ({
      ...t,
      order: orderMap.get(t.inventory.imei_serial) || null
    }));

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  createOrder,
  getOrders,
  getOrdersWithPagination,
  getMyDeliveryOrdersWithPagination,
  assignOrder,
  assignBulk,
  getOrderById,
  getVerificationOrders,
  getApprovedOrders,
  assignDelivery,
  assignBulkDelivery,
  cancelOrder,
  initiateHandover,
  verifyHandover,
  updateOrderItem,
  takeOrder,
  getCsrDashboardStats,
  getExpiredAssignedOrders,
  getDeliveryStatus,
  getDeliveredOrders,
  assignRecovery,
  assignBulkRecovery,
  getOutletDeliveryOfficers,
  getOfficerApprovedOrders,
  getHandoverHistory,
  expireOrders,
  sendOrderAssignmentNotification
};
