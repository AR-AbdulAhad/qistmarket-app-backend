const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient();
const { notifyUser } = require('../utils/notificationUtils');

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

async function sendAssignmentNotification(order, user, io = null) {
  const title = 'New Order Assigned';
  const message = `Order ${order.order_ref} has been assigned to you for verification.`;
  const type = 'order_assignment';

  // Save to DB and emit Socket.io
  if (user?.id) {
    await notifyUser(user.id, title, message, type, order.id, io);
  }

  if (!user?.fcm_token) return;

  try {
    await admin.messaging().send({
      token: user.fcm_token,
      notification: { title, body: message },
      data: {
        order_id: order.id.toString(),
        order_ref: order.order_ref,
      },
    });
  } catch (fcmError) {
    console.error('FCM send failed:', fcmError);
  }
}

async function sendDeliveryAssignmentNotification(order, user, io = null) {
  const title = 'New Order Assigned for Delivery';
  const message = `Order ${order.order_ref} has been assigned to you for Delivery.`;
  const type = 'delivery_assignment';

  // Save to DB and emit Socket.io
  if (user?.id) {
    await notifyUser(user.id, title, message, type, order.id, io);
  }

  if (!user?.fcm_token) return;

  try {
    await admin.messaging().send({
      token: user.fcm_token,
      notification: { title, body: message },
      data: {
        order_id: order.id.toString(),
        order_ref: order.order_ref,
      },
    });
  } catch (fcmError) {
    console.error('FCM send failed:', fcmError);
  }
}

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
        address: address.trim(),
        city: city ? city.trim() : null,
        area: area ? area.trim() : null,
        zone: zone ? zone.trim() : null,
        block: block ? block.trim() : null,
        street: street ? street.trim() : null,
        house_no: house_no ? house_no.trim() : null,

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
        created_by_user_id: req.user.id,
        assigned_to_user_id: assignedOfficerId
      },
      include: {
        created_by: { select: { username: true } },
        assigned_to: { select: { id: true, username: true, fcm_token: true } }
      }
    });

    // Create verification entry if assigned
    if (assignedOfficerId) {
      await prisma.verification.create({
        data: {
          order_id: order.id,
          verification_officer_id: assignedOfficerId,
          start_time: new Date(),
        }
      });
      // Send notification
      const io = req.app.get('io');
      await sendAssignmentNotification(order, order.assigned_to, io);
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
          address: order.address,
          city: order.city,
          area: order.area,
          zone: order.zone,
          block: order.block,
          street: order.street,
          house_no: order.house_no,

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
    const where = {};

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
    const baseWhere = {};

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
      },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Order not found' },
      });
    }

    return res.status(200).json({
      success: true,
      data: { order },
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
      where: { id: Number(id) },
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
        where: { id: Number(id) },
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
      where: { id: Number(user_id) },
      include: { role: true },
    });

    if (!user || user.role.name !== 'Verification Officer') {
      return res.status(400).json({ success: false, message: 'Invalid Verification Officer' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: Number(id) },
      data: {
        assigned_to_user_id: Number(user_id),
        status: 'pending'
      },
      include: {
        assigned_to: { select: { id: true, username: true, fcm_token: true } },
        created_by: { select: { username: true } },
      },
    });

    const io = req.app.get('io');
    await sendAssignmentNotification(updatedOrder, updatedOrder.assigned_to, io);

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
      where: { id: Number(user_id) },
      include: { role: true },
    });

    if (!user || user.role.name !== 'Verification Officer') {
      return res.status(400).json({ success: false, message: 'Invalid verification officer' });
    }

    const orders = await prisma.order.findMany({
      where: { id: { in: order_ids.map(Number) } },
      include: {
        assigned_to: { select: { username: true, fcm_token: true } },
      },
    });

    const alreadyAssigned = orders.filter((o) => o.assigned_to_user_id !== null);
    if (alreadyAssigned.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Some selected orders are already assigned',
      });
    }

    await prisma.order.updateMany({
      where: { id: { in: order_ids.map(Number) } },
      data: {
        assigned_to_user_id: Number(user_id),
        status: 'pending'
      },
    });

    const io = req.app.get('io');
    for (const order of orders) {
      await sendAssignmentNotification(order, user, io);
    }

    return res.status(200).json({
      success: true,
      message: 'Orders assigned successfully. Notifications sent.',
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
      assigned_to_user_id: { not: null },
      verification: {
        isNot: null,
      },
      status: 'in_progress',
    };

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
        if (key === 'verification_officer') {
          where.verification = {
            ...where.verification,
            verification_officer: { username: { contains: value } }
          };
        } else if (key === 'created_by') {
          where.created_by = { username: { contains: value } };
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

    const orders = await prisma.order.findMany({
      where,
      skip,
      take,
      orderBy: { [sortBy]: sortDir },
      select: {
        id: true,
        order_ref: true,
        token_number: true,
        customer_name: true,
        whatsapp_number: true,
        address: true,
        city: true,
        area: true,
        product_name: true,
        total_amount: true,
        advance_amount: true,
        monthly_amount: true,
        months: true,
        channel: true,
        status: true,
        created_at: true,
        updated_at: true,
        assigned_to: {
          select: {
            id: true,
            username: true,
            full_name: true,
          },
        },
        created_by: {
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
            verification_officer: {
              select: {
                id: true,
                username: true,
                full_name: true,
              },
            },
            purchaser: true,
            grantors: true,
            nextOfKin: true,
            locations: {
              orderBy: { timestamp: 'desc' },
            },
            documents: {
              orderBy: { uploaded_at: 'desc' },
            },
          },
        },
      },
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
    console.error('Error in getVerificationOrders:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const getApprovedOrders = async (req, res) => {
  const { page = 1, limit = 10, search = '', sortBy = 'created_at', sortDir = 'desc', ...filters } = req.query;

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    const where = {
      verification: {
        status: 'approved',
      },
    };

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

    // Support column filters (same as getOrders)
    Object.entries(filters).forEach(([key, value]) => {
      if (value) {
        if (key === 'delivery_officer') {
          where.delivery_officer = { username: { contains: value } };
        } else if (key === 'created_by') {
          where.created_by = { username: { contains: value } };
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

    const orders = await prisma.order.findMany({
      where,
      skip,
      take,
      orderBy: { [sortBy]: sortDir },
      include: {
        created_by: { select: { username: true, full_name: true } },
        assigned_to: { select: { username: true, full_name: true } },
        delivery_officer: { select: { username: true, full_name: true } },
        verification: { select: { id: true, status: true } },
      },
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
    console.error('getApprovedOrders error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const assignDelivery = async (req, res) => {
  const { id } = req.params;
  const { user_id, action = 'assign' } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: Number(id) },
      include: {
        delivery_officer: { select: { username: true, fcm_token: true } },
      },
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (action === 'unassign') {
      if (!order.delivery_officer_id) {
        return res.status(400).json({ success: false, message: 'Order is not assigned for delivery' });
      }

      const updated = await prisma.order.update({
        where: { id: Number(id) },
        data: { delivery_officer_id: null },
        include: {
          created_by: { select: { username: true } },
          assigned_to: { select: { username: true } },
          delivery_officer: { select: { username: true } },
        },
      });

      return res.status(200).json({
        success: true,
        message: 'Delivery unassigned successfully',
        data: { order: updated },
      });
    }

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'User ID required for assignment' });
    }

    if (order.delivery_officer_id) {
      return res.status(409).json({ success: false, message: 'Order is already assigned for delivery' });
    }

    const user = await prisma.user.findUnique({
      where: { id: Number(user_id) },
      include: { role: true },
    });

    if (!user || user.role.name !== 'Delivery Agent') {
      return res.status(400).json({ success: false, message: 'Invalid Delivery Officer' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: Number(id) },
      data: { delivery_officer_id: Number(user_id) },
      include: {
        delivery_officer: { select: { username: true, fcm_token: true } },
        created_by: { select: { username: true } },
        assigned_to: { select: { username: true } },
      },
    });

    const io = req.app.get('io');
    await sendDeliveryAssignmentNotification(updatedOrder, updatedOrder.delivery_officer, io);

    return res.status(200).json({
      success: true,
      message: 'Delivery assigned successfully',
      data: { order: updatedOrder },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const assignBulkDelivery = async (req, res) => {
  const { order_ids, user_id, action = 'assign' } = req.body;

  if (!Array.isArray(order_ids) || order_ids.length === 0) {
    return res.status(400).json({ success: false, message: 'order_ids array is required' });
  }

  try {
    if (action === 'unassign') {
      await prisma.order.updateMany({
        where: {
          id: { in: order_ids.map(Number) },
          delivery_officer_id: { not: null },
        },
        data: { delivery_officer_id: null },
      });

      return res.status(200).json({
        success: true,
        message: 'Selected deliveries have been unassigned',
      });
    }

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'user_id required for assignment' });
    }

    const user = await prisma.user.findUnique({
      where: { id: Number(user_id) },
      include: { role: true },
    });

    if (!user || user.role.name !== 'Delivery Agent') {
      return res.status(400).json({ success: false, message: 'Invalid delivery officer' });
    }

    const orders = await prisma.order.findMany({
      where: { id: { in: order_ids.map(Number) } },
      include: {
        delivery_officer: { select: { username: true, fcm_token: true } },
      },
    });

    const alreadyAssigned = orders.filter((o) => o.delivery_officer_id !== null);
    if (alreadyAssigned.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Some selected orders are already assigned for delivery',
      });
    }

    await prisma.order.updateMany({
      where: { id: { in: order_ids.map(Number) } },
      data: { delivery_officer_id: Number(user_id) },
    });

    const io = req.app.get('io');
    for (const order of orders) {
      await sendDeliveryAssignmentNotification(order, user, io);
    }

    return res.status(200).json({
      success: true,
      message: 'Deliveries assigned successfully. Notifications sent.',
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const cancelOrder = async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason || reason.trim() === '') {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Reason is mandatory for cancellation.' }
    });
  }

  try {
    const order = await prisma.order.findUnique({
      where: { id: Number(id) }
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Order not found' }
      });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: Number(id) },
      data: {
        status: 'cancelled',
        cancelled_reason: reason.trim(),
        cancelled_at: new Date()
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Order cancelled successfully',
      data: { order: updatedOrder }
    });
  } catch (error) {
    console.error('Cancel order error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

const updateOrderItem = async (req, res) => {
  const { id } = req.params;
  const { product_name } = req.body;

  if (!product_name) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'product_name is required' }
    });
  }

  try {
    const order = await prisma.order.findUnique({
      where: { id: Number(id) }
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Order not found' }
      });
    }

    const previousProduct = order.product_name;

    // Use a transaction
    const [updatedOrder, history] = await prisma.$transaction([
      prisma.order.update({
        where: { id: Number(id) },
        data: { product_name: product_name.trim() }
      }),
      prisma.orderProductHistory.create({
        data: {
          order_id: Number(id),
          previous_product: previousProduct,
          current_product: product_name.trim(),
          changed_by_user_id: req.user.id
        }
      })
    ]);

    return res.status(200).json({
      success: true,
      message: 'Order item updated successfully',
      data: { order: updatedOrder, history }
    });
  } catch (error) {
    console.error('Update order item error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
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
  updateOrderItem
};