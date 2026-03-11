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
        created_by_user_id: req.user.id,
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
      start_time: new Date(),
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
    const where = {
      status: { in: ['picked', 'approved'] },
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

    const updatedOrder = await prisma.order.update({
      where: { id: Number(id) },
      data: {
        delivery_officer_id: Number(user_id),
        status: 'picked'
      },
      include: {
        delivery_officer: { select: { id: true, username: true, fcm_token: true, full_name: true } }
      }
    });

    // Send notification
    const io = req.app.get('io');
    if (updatedOrder.delivery_officer) {
      await sendDeliveryAssignmentNotification(updatedOrder, updatedOrder.delivery_officer, io);
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

    await prisma.order.updateMany({
      where: { id: { in: order_ids.map(Number) } },
      data: {
        delivery_officer_id: Number(user_id),
        status: 'picked'
      }
    });

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
  const { reason = 'Cancelled by admin' } = req.body;

  try {
    const updatedOrder = await prisma.order.update({
      where: { id: Number(id) },
      data: {
        status: 'cancelled',
        cancelled_reason: reason,
        cancelled_at: new Date()
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Order cancelled successfully',
      data: { order: updatedOrder }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const updateOrderItem = async (req, res) => {
  const { id } = req.params;
  const { product_name } = req.body;

  if (!product_name) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Product name is required' }
    });
  }

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(id) }
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Order not found' }
      });
    }

    const previous_product = order.product_name;

    const [updatedOrder, history] = await prisma.$transaction([
      prisma.order.update({
        where: { id: parseInt(id) },
        data: { product_name }
      }),
      prisma.orderProductHistory.create({
        data: {
          order_id: parseInt(id),
          previous_product,
          current_product: product_name,
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

const getDeliveryStatus = async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: {
        delivery_officer_id: { not: null }
      },
      select: {
        id: true,
        order_ref: true,
        customer_name: true,
        address: true,
        product_name: true,
        advance_amount: true,
        status: true,
        updated_at: true,
        delivery_officer: {
          select: {
            username: true,
            full_name: true
          }
        }
      },
      orderBy: { updated_at: 'desc' }
    });

    const formattedOrders = orders.map(o => ({
      id: o.id,
      order_ref: o.order_ref,
      customer_name: o.customer_name,
      address: o.address,
      product_name: o.product_name,
      amount: o.advance_amount,
      status: o.status,
      delivery_officer: o.delivery_officer,
      updated_at: o.updated_at
    }));

    return res.status(200).json({
      success: true,
      data: formattedOrders
    });
  } catch (error) {
    console.error('getDeliveryStatus error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

const getDeliveredOrders = async (req, res) => {
  const { page = 1, limit = 10, search = '' } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    const where = {
      status: 'delivered',
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
        orderBy: { updated_at: 'desc' },
        include: {
          recovery_officer: {
            select: { id: true, full_name: true, username: true }
          },
          created_by: {
            select: { id: true, full_name: true, username: true }
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
          total,
          page: Number(page),
          limit: Number(limit),
          totalPages: Math.ceil(total / take),
        },
      },
    });
  } catch (error) {
    console.error('getDeliveredOrders error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const assignRecovery = async (req, res) => {
  const { id } = req.params;
  const { user_id, action = 'assign' } = req.body;

  try {
    if (action === 'unassign') {
      const updatedOrder = await prisma.order.update({
        where: { id: Number(id) },
        data: { recovery_officer_id: null },
        include: { recovery_officer: { select: { id: true, username: true, full_name: true } } }
      });
      return res.status(200).json({
        success: true,
        message: 'Recovery officer unassigned successfully',
        data: { order: updatedOrder }
      });
    }

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'recovery_officer_id required' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: Number(id) },
      data: { recovery_officer_id: Number(user_id) },
      include: { recovery_officer: { select: { id: true, username: true, full_name: true } } }
    });

    return res.status(200).json({
      success: true,
      message: 'Recovery officer assigned successfully',
      data: { order: updatedOrder }
    });
  } catch (error) {
    console.error('assignRecovery error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const assignBulkRecovery = async (req, res) => {
  const { order_ids, user_id, action = 'assign' } = req.body;

  if (!Array.isArray(order_ids) || order_ids.length === 0) {
    return res.status(400).json({ success: false, message: 'order_ids required' });
  }

  try {
    if (action === 'unassign') {
      await prisma.order.updateMany({
        where: { id: { in: order_ids.map(Number) } },
        data: { recovery_officer_id: null }
      });
      return res.status(200).json({
        success: true,
        message: `${order_ids.length} orders unassigned from recovery`
      });
    }

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'user_id required' });
    }

    await prisma.order.updateMany({
      where: { id: { in: order_ids.map(Number) } },
      data: { recovery_officer_id: Number(user_id) }
    });

    return res.status(200).json({
      success: true,
      message: `${order_ids.length} orders assigned for recovery`
    });
  } catch (error) {
    console.error('assignBulkRecovery error:', error);
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
  updateOrderItem,
  getDeliveryStatus,
  getDeliveredOrders,
  assignRecovery,
  assignBulkRecovery
};