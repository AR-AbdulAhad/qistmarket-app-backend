const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { saveOTP, verifyOTP } = require('../utils/otpUtils');
const { sendOTP } = require('../services/watiService');
const { notifyAdmins } = require('../utils/notificationUtils');

// Submit Delivery (Batch Upload)
const submitDelivery = async (req, res) => {
  const { order_id } = req.body;

  if (!order_id) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'order_id is required' }
    });
  }

  try {
    // Check if order exists and is assigned to the current user
    const order = await prisma.order.findUnique({
      where: {
        id: parseInt(order_id),
        delivery_officer_id: req.user.id
      },
      include: { delivery: true }
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Order not found or not assigned to you' }
      });
    }

    if (order.delivery) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Delivery already submitted for this order' }
      });
    }

    // Process files and tags
    const facePhotos = req.files['face_photos'] || [];
    const locationPhotos = req.files['location_photos'] || [];
    const housePhotos = req.files['house_photos'] || [];

    const faceTags = req.body.face_tags ? JSON.parse(req.body.face_tags) : [];
    const locationTags = req.body.location_tags ? JSON.parse(req.body.location_tags) : [];
    const houseTags = req.body.house_tags ? JSON.parse(req.body.house_tags) : [];
    const locationLinks = req.body.location_links ? JSON.parse(req.body.location_links) : [];
    const linkTags = req.body.link_tags ? JSON.parse(req.body.link_tags) : [];

    // Validate counts
    if (facePhotos.length > 5 || locationPhotos.length > 5 || housePhotos.length > 5 || locationLinks.length > 5) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Maximum 5 items per type allowed' }
      });
    }

    // Create delivery
    const delivery = await prisma.delivery.create({
      data: {
        order_id: parseInt(order_id),
        delivery_agent_id: req.user.id,
        status: 'completed',
        start_time: new Date(),
        end_time: new Date(),
        verified: true
      }
    });

    // Create uploads
    const uploadsData = [];

    // Face photos
    facePhotos.forEach((file, index) => {
      uploadsData.push({
        delivery_id: delivery.id,
        upload_type: 'face_photo',
        file_url: file.url,
        tag: faceTags[index] || null,
        uploaded_at: new Date()
      });
    });

    // Location photos
    locationPhotos.forEach((file, index) => {
      uploadsData.push({
        delivery_id: delivery.id,
        upload_type: 'location_photo',
        file_url: file.url,
        tag: locationTags[index] || null,
        uploaded_at: new Date()
      });
    });

    // House photos
    housePhotos.forEach((file, index) => {
      uploadsData.push({
        delivery_id: delivery.id,
        upload_type: 'house_photo',
        file_url: file.url,
        tag: houseTags[index] || null,
        uploaded_at: new Date()
      });
    });

    // Location links
    locationLinks.forEach((link, index) => {
      uploadsData.push({
        delivery_id: delivery.id,
        upload_type: 'location_link',
        link: link,
        tag: linkTags[index] || null,
        uploaded_at: new Date()
      });
    });

    if (uploadsData.length > 0) {
      await prisma.deliveryUpload.createMany({
        data: uploadsData
      });
    }

    // Update order status
    await prisma.order.update({
      where: { id: parseInt(order_id) },
      data: {
        status: 'delivered',
        is_delivered: true
      }
    });

    // Fetch updated delivery
    const updatedDelivery = await prisma.delivery.findUnique({
      where: { id: delivery.id },
      include: {
        delivery_agent: {
          select: { full_name: true, username: true }
        },
        uploads: true,
        order: { select: { order_ref: true } }
      }
    });

    const io = req.app.get('io');
    await notifyAdmins(
      'Delivery Submitted',
      `Delivery completed for Order #${updatedDelivery.order.order_ref} by ${updatedDelivery.delivery_agent.full_name}`,
      'delivery_complete',
      updatedDelivery.id,
      io
    );

    return res.status(201).json({
      success: true,
      message: 'Delivery submitted successfully',
      data: { delivery: updatedDelivery }
    });
  } catch (error) {
    console.error('Submit delivery error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Get Delivery by Order ID
const getDeliveryByOrderId = async (req, res) => {
  const { order_id } = req.params;

  console.log('Get delivery for order_id:', order_id);

  try {
    const delivery = await prisma.delivery.findUnique({
      where: { order_id: parseInt(order_id) },
      include: {
        delivery_agent: {
          select: { full_name: true, username: true }
        },
        uploads: true
      }
    });

    if (!delivery) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Delivery not found for this order' }
      });
    }


    return res.status(200).json({
      success: true,
      data: { delivery }
    });
  } catch (error) {
    console.error('Get delivery by order error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

const getPendingDeliveryProducts = async (req, res) => {
  try {
    const deliveryBoyId = req.user.id;

    if (!deliveryBoyId) {
      return res.status(401).json({
        success: false,
        error: { code: 401, message: 'Authentication required' }
      });
    }

    // Fetch all pending orders with only needed fields
    const orders = await prisma.order.findMany({
      where: {
        delivery_officer_id: deliveryBoyId,
        is_delivered: false,           // or delivery: null if you chose that approach
      },
      select: {
        product_name: true,
        total_amount: true,
        advance_amount: true,
        monthly_amount: true,
        months: true,
      },
      orderBy: {
        updated_at: 'desc',
      },
    });

    if (orders.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No pending delivery orders assigned',
        data: [],
      });
    }

    const grouped = {};

    orders.forEach((order) => {
      const productKey = (order.product_name || 'N/A').trim().toLowerCase();

      if (!grouped[productKey]) {
        grouped[productKey] = {
          product_name: order.product_name.trim() || 'N/A',
          count: 0,
          total_amount: 0,
          advance_amount: 0,
          monthly_amount: 0,
          months: 0,
          sample_months: order.months ?? 0,
        };
      }

      const group = grouped[productKey];
      group.count += 1;
      group.total_amount += order.total_amount;
      group.advance_amount += order.advance_amount ?? 0;
      group.monthly_amount += order.monthly_amount ?? 0;

      if (group.months === 0 && order.months > 0) {
        group.months = order.months;
      }
    });

    // Convert grouped object to array
    const result = Object.values(grouped).map((group) => ({
      product_name: group.product_name,
      count: group.count,
      total_amount: Math.round(group.total_amount * 100) / 100,
      advance_amount: Math.round(group.advance_amount * 100) / 100,
      monthly_amount: Math.round(group.monthly_amount * 100) / 100,
      months: group.months || group.sample_months,
    }));

    result.sort((a, b) => b.count - a.count || a.product_name.localeCompare(b.product_name));

    return res.status(200).json({
      success: true,
      products: result,
    });
  } catch (error) {
    console.error('Error fetching grouped pending products:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const getCashInHand = async (req, res) => {
  try {
    const deliveryBoyId = req.user.id;

    if (!deliveryBoyId) {
      return res.status(401).json({
        success: false,
        error: { code: 401, message: 'Authentication required' }
      });
    }

    const deliveries = await prisma.delivery.findMany({
      where: {
        delivery_agent_id: deliveryBoyId,
        status: 'completed',
      },
      include: {
        order: {
          select: {
            id: true,
            product_name: true,
            advance_amount: true,
          }
        }
      },
      orderBy: {
        created_at: 'desc'
      }
    });

    if (deliveries.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No cash in hand entries',
        data: [],
        total_unpaid: 0
      });
    }

    const cashEntries = deliveries.map(d => ({
      order_id: d.order.id,
      product_name: d.order.product_name,
      amount: d.order.advance_amount,
      status: 'unpaid',
      created_at: d.end_time,
      updated_at: d.end_time
    }));

    const totalUnpaid = cashEntries.reduce((sum, entry) => sum + (entry.amount || 0), 0);

    return res.status(200).json({
      success: true,
      data: cashEntries,
      total_unpaid: totalUnpaid
    });
  } catch (error) {
    console.error('Error fetching cash in hand:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Generate Delivery OTP
const generateDeliveryOtp = async (req, res) => {
  const { order_id } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) }
    });

    if (!order) {
      return res.status(404).json({ success: false, error: { message: 'Order not found' } });
    }

    if (order.delivery_officer_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { message: 'Order not assigned to you' } });
    }

    const otp = await saveOTP(order.phone, 'delivery');
    await sendOTP(order.phone, otp);

    return res.status(200).json({ success: true, message: 'OTP sent to customer' });
  } catch (error) {
    console.error('generateDeliveryOtp error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

// Verify Delivery OTP
const verifyDeliveryOtp = async (req, res) => {
  const { order_id, otp } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) }
    });

    if (!order) return res.status(404).json({ success: false, error: { message: 'Order not found' } });

    const verification = await verifyOTP(order.phone, otp, 'delivery');
    if (!verification.valid) {
      return res.status(400).json({ success: true, valid: false, message: verification.message });
    }

    // Mark as delivered
    await prisma.order.update({
      where: { id: parseInt(order_id) },
      data: { status: 'delivered', is_delivered: true }
    });

    // Create delivery record if not exists
    await prisma.delivery.upsert({
      where: { order_id: parseInt(order_id) },
      update: { status: 'completed', end_time: new Date(), verified: true },
      create: {
        order_id: parseInt(order_id),
        delivery_agent_id: req.user.id,
        status: 'completed',
        start_time: new Date(),
        end_time: new Date(),
        verified: true
      }
    });

    return res.status(200).json({ success: true, valid: true, message: 'Delivery verified and completed' });
  } catch (error) {
    console.error('verifyDeliveryOtp error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

// Return Product
const returnProduct = async (req, res) => {
  const { order_id, reason } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) }
    });

    if (!order) return res.status(404).json({ success: false, error: { message: 'Order not found' } });

    await prisma.order.update({
      where: { id: parseInt(order_id) },
      data: {
        status: 'returned',
        cancelled_reason: reason,
        cancelled_at: new Date()
      }
    });

    return res.status(200).json({ success: true, message: 'Product marked as returned' });
  } catch (error) {
    console.error('returnProduct error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

// Generate Refund OTP
const generateRefundOtp = async (req, res) => {
  const { order_id } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) }
    });

    if (!order) return res.status(404).json({ success: false, error: { message: 'Order not found' } });

    const otp = await saveOTP(order.phone, 'refund');
    await sendOTP(order.phone, otp);

    return res.status(200).json({ success: true, message: 'Refund OTP sent to customer' });
  } catch (error) {
    console.error('generateRefundOtp error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

// Verify Refund OTP
const verifyRefundOtp = async (req, res) => {
  const { order_id, otp } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) }
    });

    if (!order) return res.status(404).json({ success: false, error: { message: 'Order not found' } });

    const verification = await verifyOTP(order.phone, otp, 'refund');
    if (!verification.valid) {
      return res.status(400).json({ success: true, valid: false, message: verification.message });
    }

    await prisma.order.update({
      where: { id: parseInt(order_id) },
      data: { status: 'refunded' }
    });

    return res.status(200).json({ success: true, valid: true, message: 'Refund verified and processed' });
  } catch (error) {
    console.error('verifyRefundOtp error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

module.exports = {
  submitDelivery,
  getDeliveryByOrderId,
  getPendingDeliveryProducts,
  getCashInHand,
  generateDeliveryOtp,
  verifyDeliveryOtp,
  returnProduct,
  generateRefundOtp,
  verifyRefundOtp
};