const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { saveOTP, verifyOTP } = require('../utils/otpUtils');
const { sendOTP } = require('../services/watiService');
const { notifyAdmins } = require('../utils/notificationUtils');

// Submit Delivery (Batch Upload)
const submitDelivery = async (req, res) => {
  const { order_id, product_imei, selected_plan } = req.body;

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
      include: {
        delivery: true,
        verification: { include: { purchaser: true } }
      }
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
        verified: true,
        product_imei: product_imei || null,
        selected_plan: selected_plan || null
      }
    });

    // Snapshot variables for Cash In Hand
    let colorVariant = null;
    let productNameSnapshot = order.product_name;
    let stockTransferId = null;

    // Update Inventory Status and Transfer History if IMEI provided
    if (product_imei) {
      const inventory = await prisma.outletInventory.findFirst({
        where: { imei_serial: product_imei }
      });

      if (inventory) {
        // Mark inventory as out of stock
        await prisma.outletInventory.update({
          where: { id: inventory.id },
          data: { status: 'Out Of Stock' }
        });

        colorVariant = inventory.color_variant || null;
        productNameSnapshot = inventory.product_name || order.product_name;

        // Mark transfer as delivered
        const transfer = await prisma.stockTransfer.findFirst({
          where: {
            inventory_id: inventory.id,
            to_id: req.user.id,
            to_type: 'Delivery Officer',
            status: 'pending'
          }
        });

        if (transfer) {
          stockTransferId = transfer.id;
          await prisma.stockTransfer.update({
            where: { id: transfer.id },
            data: { status: 'delivered' }
          });
        }
      }
    }

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

    // Determine advance amount STRICTLY from delivery context (selected_plan)
    let advanceAmount = 0.0;
    let planObj = null;

    if (selected_plan) {
      try {
        planObj = typeof selected_plan === 'string' ? JSON.parse(selected_plan) : selected_plan;
        if (planObj && (planObj.advance !== undefined || planObj.advance_amount !== undefined)) {
          advanceAmount = parseFloat(planObj.advance || planObj.advance_amount);
        }
      } catch (e) {
        console.error('Error parsing selected_plan:', e);
      }
    }

    // Get confirmed purchaser name from verification if available
    const confirmedCustomerName = order.verification?.purchaser?.full_name || order.customer_name;

    // Create Cash In Hand entry for advance amount using delivery snapshots
    if (advanceAmount > 0) {
      await prisma.cashInHand.create({
        data: {
          delivery_officer_id: req.user.id,
          order_id: parseInt(order_id),
          amount: advanceAmount,
          status: 'pending',
          customer_name: confirmedCustomerName,
          product_name: productNameSnapshot || order.product_name,
          imei_serial: product_imei || null,
          color_variant: colorVariant || null,
          stock_transfer_id: stockTransferId
        }
      });
    }

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

    const orders = await prisma.order.findMany({
      where: {
        delivery_officer_id: deliveryBoyId,
        is_delivered: false,
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
  const { date_from, date_to, status, date } = req.query;
  const deliveryBoyId = req.user?.id;

  try {
    let where = {
      delivery_officer_id: deliveryBoyId,
    };

    if (status) {
      where.status = status;
    }

    if (date) {
      const selectedDate = new Date(date);
      const nextDay = new Date(date);
      nextDay.setDate(nextDay.getDate() + 1);
      where.created_at = {
        gte: selectedDate,
        lt: nextDay
      };
    } else if (date_from || date_to) {
      where.created_at = {};
      if (date_from) where.created_at.gte = new Date(date_from);
      if (date_to) where.created_at.lte = new Date(date_to);
    } else {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      where.created_at = { gte: today };
    }

    const cashEntries = await prisma.cashInHand.findMany({
      where,
      include: {
        order: {
          select: {
            id: true,
            order_ref: true,
            product_name: true,
            imei_serial: true,
            advance_amount: true,
            created_at: true,
            customer_name: true,
            delivery: {
              select: {
                selected_plan: true,
                product_imei: true
              }
            }
          }
        },
        outlet: {
          select: { name: true, code: true }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    const formattedEntries = cashEntries.map(entry => ({
      id: entry.id,
      amount: entry.amount,
      status: entry.status,
      created_at: entry.created_at,
      payment_method: entry.payment_method,
      order_id: entry.order.id,
      order_ref: entry.order.order_ref,
      customer_name: entry.customer_name || entry.order?.customer_name,
      product_name: entry.product_name || entry.order.product_name,
      imei: entry.imei_serial || entry.order.imei_serial || entry.order.delivery?.product_imei,
      color_variant: entry.color_variant,
      selected_plan: entry.order.delivery?.selected_plan,
      outlet: entry.outlet
    }));

    const totalUnpaid = formattedEntries
      .filter(e => e.status === 'pending')
      .reduce((sum, e) => sum + (e.amount || 0), 0);

    return res.status(200).json({
      success: true,
      data: formattedEntries,
      total_unpaid: totalUnpaid
    });
  } catch (error) {
    console.error('getCashInHand error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

const submitCashToOutlet = async (req, res) => {
  const { cash_in_hand_ids, cash_in_hand_id, outlet_id, payment_method } = req.body;
  const deliveryBoyId = req.user?.id;

  let ids = [];
  if (cash_in_hand_ids && Array.isArray(cash_in_hand_ids)) {
    ids = cash_in_hand_ids.map(id => parseInt(id));
  } else if (cash_in_hand_id) {
    ids = [parseInt(cash_in_hand_id)];
  }

  if (ids.length === 0 || !outlet_id) {
    return res.status(400).json({ success: false, message: 'cash_in_hand_ids and outlet_id are required' });
  }

  try {
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    await prisma.cashInHand.updateMany({
      where: {
        id: { in: ids },
        delivery_officer_id: deliveryBoyId,
      },
      data: {
        outlet_id: parseInt(outlet_id),
        payment_method: payment_method || 'Cash',
        otp: otp
      }
    });

    const entries = await prisma.cashInHand.findMany({
      where: { id: { in: ids } },
      include: {
        delivery_officer: { select: { full_name: true, phone: true } },
        order: { select: { product_name: true, order_ref: true } }
      }
    });

    if (entries.length === 0) {
      return res.status(404).json({ success: false, message: 'No pending cash entries found' });
    }

    const totalAmount = entries.reduce((sum, e) => sum + e.amount, 0);
    const officerName = entries[0]?.delivery_officer?.full_name || 'Officer';
    const officerPhone = entries[0]?.delivery_officer?.phone;

    // Send OTP to Delivery Officer via WhatsApp (Wati)
    if (officerPhone) {
      try {
        await sendOTP(officerPhone, otp);
        console.log(`OTP ${otp} sent to officer ${officerName} at ${officerPhone}`);
      } catch (err) {
        console.error('Error sending OTP to officer:', err);
      }
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`outlet_${outlet_id}`).emit('cash_submission_requested', {
        officer_name: officerName,
        amount: totalAmount,
        payment_method: payment_method || 'Cash',
        otp: otp,
        entries: entries.map(e => ({
          customer_name: e.customer_name,
          order_ref: e.order.order_ref,
          product_name: e.product_name,
          imei: e.imei_serial,
          color: e.color_variant,
          amount: e.amount
        }))
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Cash submission initiated. OTP has been sent to your WhatsApp.',
      total_amount: totalAmount
    });
  } catch (error) {
    console.error('submitCashToOutlet error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};


const generateDeliveryOtp = async (req, res) => {
  const { order_id } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        verification: {
          include: {
            purchaser: true
          }
        }
      }
    });

    if (!order) {
      return res.status(404).json({ success: false, error: { message: 'Order not found' } });
    }

    if (!order.verification || !order.verification.purchaser) {
      return res.status(404).json({ success: false, error: { message: 'Verification or purchaser details not found' } });
    }

    if (order.delivery_officer_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { message: 'Order not assigned to you' } });
    }

    const purchaserNumber = order.verification.purchaser.telephone_number;
    const otp = await saveOTP(purchaserNumber, 'delivery');
    await sendOTP(purchaserNumber, otp);

    const io = req.app.get('io');
    await notifyAdmins(
      'Delivery OTP Generated',
      `OTP sent to purchaser for Order #${order_id}`,
      'delivery_otp_generated',
      order_id,
      io
    );

    return res.status(200).json({ success: true, message: 'OTP sent to customer' });
  } catch (error) {
    console.error('generateDeliveryOtp error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

const verifyDeliveryOtp = async (req, res) => {
  const { order_id, otp } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        verification: {
          include: {
            purchaser: true
          }
        }
      }
    });

    if (!order) return res.status(404).json({ success: false, error: { message: 'Order not found' } });

    if (!order.verification || !order.verification.purchaser) {
      return res.status(404).json({ success: false, error: { message: 'Verification or purchaser details not found' } });
    }

    const purchaserNumber = order.verification.purchaser.telephone_number;
    const verification = await verifyOTP(purchaserNumber, otp, 'delivery');
    if (!verification.valid) {
      return res.status(400).json({ success: true, valid: false, message: verification.message });
    }

    const io = req.app.get('io');
    await notifyAdmins(
      'Delivery OTP Verified',
      `OTP verified for Order #${order_id}`,
      'delivery_otp_verified',
      order_id,
      io
    );

    return res.status(200).json({ success: true, valid: true, message: 'OTP verified successfully' });
  } catch (error) {
    console.error('verifyDeliveryOtp error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

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

    const io = req.app.get('io');
    await notifyAdmins(
      'Product Returned',
      `Product for Order #${order_id} has been returned. Reason: ${reason}`,
      'product_returned',
      order_id,
      io
    );

    return res.status(200).json({ success: true, message: 'Product marked as returned' });
  } catch (error) {
    console.error('returnProduct error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

const generateRefundOtp = async (req, res) => {
  const { order_id } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) }
    });

    if (!order) return res.status(404).json({ success: false, error: { message: 'Order not found' } });

    const otp = await saveOTP(order.phone, 'refund');
    await sendOTP(order.phone, otp);

    const io = req.app.get('io');
    await notifyAdmins(
      'Refund OTP Generated',
      `OTP sent to customer for refund of Order #${order_id}`,
      'refund_otp_generated',
      order_id,
      io
    );

    return res.status(200).json({ success: true, message: 'Refund OTP sent to customer' });
  } catch (error) {
    console.error('generateRefundOtp error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

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

    const io = req.app.get('io');
    await notifyAdmins(
      'Refund Processed',
      `Refund for Order #${order_id} has been verified and processed`,
      'refund_processed',
      order_id,
      io
    );

    return res.status(200).json({ success: true, valid: true, message: 'Refund verified and processed' });
  } catch (error) {
    console.error('verifyRefundOtp error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

const getDeliveryBoyInventory = async (req, res) => {
  try {
    const deliveryBoyId = req.user.id;

    const transfers = await prisma.stockTransfer.findMany({
      where: { to_type: 'Delivery Officer', to_id: deliveryBoyId, status: 'pending' },
      include: {
        inventory: {
          select: {
            id: true,
            product_name: true,
            category: true,
            color_variant: true,
            imei_serial: true,
            quantity: true,
            purchase_price: true,
            status: true,
            installment_plans: true
          }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    const outletIds = [...new Set(transfers.filter(t => t.from_type === 'Outlet').map(t => t.from_id))];
    const outlets = outletIds.length > 0
      ? await prisma.outlet.findMany({
        where: { id: { in: outletIds } },
        select: { id: true, name: true, code: true }
      })
      : [];

    const groupMap = new Map();

    for (const t of transfers) {
      const key = `${t.inventory.product_name}||${t.inventory.color_variant || ''}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          product_name: t.inventory.product_name,
          category: t.inventory.category,
          color_variant: t.inventory.color_variant || null,
          purchase_price: t.inventory.purchase_price,
          installment_plans: t.inventory.installment_plans,
          total_qty: 0,
          units: []
        });
      }
      const grp = groupMap.get(key);
      const qty = t.quantity_transferred || 1;
      const outlet = outlets.find(o => o.id === t.from_id);
      grp.total_qty += qty;
      grp.units.push({
        transfer_id: t.id,
        transferred_at: t.created_at,
        quantity_transferred: qty,
        imei_serial: t.inventory.imei_serial || null,
        status: t.inventory.status,
        outlet: outlet ? { name: outlet.name, code: outlet.code } : null
      });
    }

    const grouped = Array.from(groupMap.values());

    return res.json({ success: true, count: grouped.length, grouped });
  } catch (error) {
    console.error('getDeliveryBoyInventory error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const pickOrder = async (req, res) => {
  const { order_id } = req.body;

  try {
    if (!order_id) {
      return res.status(404).json({ success: false, error: { message: 'Order not found' } });
    }

    await prisma.order.update({
      where: { id: parseInt(order_id) },
      data: { status: 'picked' }
    });

    const io = req.app.get('io');
    await notifyAdmins(
      'Order Picked',
      `Order #${order_id} has been picked`,
      'order_picked',
      order_id,
      io
    );

    return res.status(200).json({ success: true, message: 'Order status changed to Picked' });
  } catch (error) {
    console.error('pickOrder error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

const unpickOrder = async (req, res) => {
  const { order_id } = req.body;

  try {
    if (!order_id) {
      return res.status(404).json({ success: false, error: { message: 'Order not found' } });
    }
    await prisma.order.update({
      where: { id: parseInt(order_id) },
      data: { status: 'approved' }
    });

    const io = req.app.get('io');
    await notifyAdmins(
      'Order Unpicked',
      `Order #${order_id} has been unpicked and status changed back to approved`,
      'order_unpicked',
      order_id,
      io
    );

    return res.status(200).json({ success: true, message: 'Order status changed back to approved' });
  } catch (error) {
    console.error('unpickOrder error:', error);
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
  verifyRefundOtp,
  getDeliveryBoyInventory,
  pickOrder,
  unpickOrder,
  submitCashToOutlet
};
