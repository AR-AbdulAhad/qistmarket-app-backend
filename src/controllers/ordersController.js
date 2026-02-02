const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient();

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

async function sendAssignmentNotification(order, user) {
  if (!user?.fcm_token) return;

  try {
    await admin.messaging().send({
      token: user.fcm_token,
      notification: {
        title: 'New Order Assigned',
        body: `Order ${order.order_ref} has been assigned to you for verification.`,
      },
      data: {
        order_id: order.id.toString(),
        order_ref: order.order_ref,
      },
    });
  } catch (fcmError) {
    console.error('FCM send failed:', fcmError);
  }
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
    channel
  } = req.body;

  if (!customer_name || !whatsapp_number || !address || !product_name ||
      !total_amount || !advance_amount || !monthly_amount || !months || !channel) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Required fields are missing.' }
    });
  }

  if (city && area) {
    // You could add server-side check against the same API if desired
  }

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const existing = await prisma.order.findFirst({
      where: {
        whatsapp_number: whatsapp_number.trim(),
        product_name: product_name.trim(),
        created_at: { gte: today, lt: tomorrow },
        status: { notIn: ['cancelled', 'delivered'] }
      }
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        error: { code: 409, message: 'Duplicate active order detected today.' }
      });
    }

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const order_ref = `QIST-${dateStr}-${randomNum}`;

    const token_number = crypto.randomBytes(4).toString('hex').toUpperCase();

    const order = await prisma.order.create({
      data: {
        order_ref,
        token_number,
        customer_name: customer_name.trim(),
        whatsapp_number: whatsapp_number.trim(),
        address: address.trim(),
        city: city ? city.trim() : null,
        area: area ? area.trim() : null,
        product_name: product_name.trim(),
        total_amount: parseFloat(total_amount),
        advance_amount: parseFloat(advance_amount),
        monthly_amount: parseFloat(monthly_amount),
        months: parseInt(months),
        channel: channel.trim(),
        status: 'new',
        created_by_user_id: req.user.id
      },
      include: { created_by: { select: { username: true } } }
    });

    return res.status(201).json({
      success: true,
      message: 'Order created successfully.',
      data: {
        order: {
          id: order.id,
          order_ref: order.order_ref,
          token_number: order.token_number,
          customer_name: order.customer_name,
          whatsapp_number: order.whatsapp_number,
          address: order.address,
          city: order.city,
          area: order.area,
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
    console.error(error);
    res.status(500).json({
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
        } else {
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
        created_by: { select: { username: true } },
        assigned_to: { select: { username: true } },
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
        created_by: { select: { username: true } },
        assigned_to: { select: { username: true } },
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

const getOrderById = async (req, res) => {
  const { id } = req.params;

  try {
    const order = await prisma.order.findUnique({
      where: { id: Number(id) },
      include: {
        created_by: { select: { username: true } },
        assigned_to: { select: { username: true } },
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
      data: { assigned_to_user_id: Number(user_id) },
      include: {
        assigned_to: { select: { username: true, fcm_token: true } },
        created_by: { select: { username: true } },
      },
    });

    await sendAssignmentNotification(updatedOrder, updatedOrder.assigned_to);

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
      data: { assigned_to_user_id: Number(user_id) },
    });

    for (const order of orders) {
      await sendAssignmentNotification(order, user);
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
  try {
    const orders = await prisma.order.findMany({
      where: {
        assigned_to_user_id: { not: null },
        verification: {
          isNot: null,
        },
      },
      orderBy: {
        created_at: 'desc',
      },
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
            is_approved: true,
            admin_remarks: true,
            approved_at: true,
            
            verification_officer: {
              select: {
                id: true,
                username: true,
                full_name: true,
              },
            },
            
            approved_by_user: {
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

    return res.status(200).json({
      success: true,
      data: { orders },
    });
  } catch (error) {
    console.error('Error in getVerificationOrders:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

module.exports = { 
  createOrder, 
  getOrders, 
  getOrdersWithPagination,
  assignOrder, 
  assignBulk, 
  getOrderById,
  getVerificationOrders
};