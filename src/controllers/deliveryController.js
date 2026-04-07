const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const jwt = require('jsonwebtoken');
const { saveOTP, verifyOTP } = require('../utils/otpUtils');
const { sendOTP, sendDeliveryConfirmation, sendInstallmentLedger } = require('../services/watiService');
const { notifyAdmins } = require('../utils/notificationUtils');

const LEDGER_TOKEN_SECRET = process.env.LEDGER_TOKEN_SECRET;
const LEDGER_BASE_URL = (process.env.LEDGER_BASE_URL || 'http://localhost:5000').replace(/\/$/, '')

// ─── Helpers ────────────────────────────────────────────────────────────────

const formatDatePK = (d) => {
  const date = d ? new Date(d) : new Date();
  return date.toLocaleDateString('en-PK', {
    day: '2-digit', month: 'short', year: 'numeric',
    timeZone: 'Asia/Karachi'
  });
};

const addMonths = (date, n) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
};

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
        // Mark inventory as Sold since it has been successfully delivered
        await prisma.outletInventory.update({
          where: { id: inventory.id },
          data: { status: 'Sold' }
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
    const purchaser = order.verification?.purchaser;
    const confirmedCustomerName = purchaser?.name || purchaser?.full_name || order.customer_name;

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

    // ─── Build Installment Ledger ────────────────────────────────────────────
    let installmentLedger = null;
    let ledgerUrl = null;
    try {
      // Parse plan for installment data
      const monthlyAmt = planObj?.monthly_amount || planObj?.monthlyAmount || order.monthly_amount || 0;
      const totalMonths = planObj?.months || planObj?.duration || order.months || 0;
      const deliveryDate = new Date();

      if (totalMonths > 0 && monthlyAmt > 0) {
        // Build rows: month 1 due date = delivery date + 1 month
        const ledgerRows = Array.from({ length: totalMonths }, (_, i) => ({
          month: i + 1,
          due_date: addMonths(deliveryDate, i + 1).toISOString(),
          amount: monthlyAmt,
          status: 'pending',
          paid_at: null,
        }));

        // Sign a long-lived token (2 years)
        const ledgerToken = jwt.sign(
          { order_id: parseInt(order_id), delivery_id: delivery.id },
          LEDGER_TOKEN_SECRET,
          { expiresIn: '730d' }
        );

        // ledgerUrl = `${LEDGER_BASE_URL}/api/ledger/${ledgerToken}`;
        ledgerUrl = `link comming soon`;

        // Upsert ledger (safe if re-run)
        installmentLedger = await prisma.installmentLedger.upsert({
          where: { order_id: parseInt(order_id) },
          create: {
            order_id: parseInt(order_id),
            delivery_id: delivery.id,
            token: ledgerToken,
            ledger_rows: ledgerRows,
          },
          update: {
            token: ledgerToken,
            ledger_rows: ledgerRows,
          },
        });
      }
    } catch (ledgerErr) {
      // Non-fatal — log and continue
      console.error('[submitDelivery] Ledger creation error:', ledgerErr);
    }

    // ─── WATI Messages ───────────────────────────────────────────────────────
    const customerPhone = purchaser?.telephone_number;
    const deliveryDateStr = formatDatePK(new Date());
    const colorVariantStr = colorVariant || 'N/A';

    if (customerPhone) {
      // Template 1: Delivery Confirmation
      sendDeliveryConfirmation(customerPhone, {
        customerName: confirmedCustomerName,
        productName: productNameSnapshot,
        imei: product_imei || 'N/A',
        colorVariant: colorVariantStr,
        advanceAmount,
        deliveryDate: deliveryDateStr,
        orderRef: order.order_ref,
        orderStatus: 'Delivered',
      }).then(r => console.log('[WATI] Delivery confirmation:', r.success ? 'sent ✓' : r.error))
        .catch(e => console.error('[WATI] Delivery confirmation error:', e));

      // Template 2: Installment Ledger (only if ledger was created)
      if (installmentLedger && ledgerUrl) {
        const rows = Array.isArray(installmentLedger.ledger_rows) ? installmentLedger.ledger_rows : [];
        const firstRow = rows[0];
        const totalRemain = rows.reduce((s, r) => s + (r.amount || 0), 0);

        sendInstallmentLedger(customerPhone, {
          customerName: confirmedCustomerName,
          productName: productNameSnapshot,
          orderRef: order.order_ref,
          nextMonthLabel: 'Mahina 1',
          monthlyAmount: firstRow?.amount || 0,
          dueDate: firstRow ? formatDatePK(firstRow.due_date) : 'N/A',
          totalRemaining: totalRemain,
          ledgerUrl,
        }).then(r => console.log('[WATI] Ledger template:', r.success ? 'sent ✓' : r.error))
          .catch(e => console.error('[WATI] Ledger template error:', e));
      }
    } else {
      console.warn('[submitDelivery] No customer phone — WATI messages skipped for order', order.order_ref);
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
      data: { delivery: updatedDelivery, ledger_url: ledgerUrl }
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

// =======================
// RETURN & EXCHANGE MODULE
// =======================

const initiateReturnExchange = async (req, res) => {
  const { order_id, type, is_cash_refund, refund_amount } = req.body; // type = 'Return' or 'Exchange'
  const delivery_officer_id = req.user.id; // Use authenticated officer ID

  if (!order_id || !['Return', 'Exchange'].includes(type)) {
    return res.status(400).json({ success: false, error: 'Valid order_id and type (Return/Exchange) are required.' });
  }

  try {
    // Check if the order was delivered by this officer
    const delivery = await prisma.delivery.findUnique({
      where: { order_id: parseInt(order_id) },
      include: {
        order: {
          include: {
            cash_in_hand: {
              take: 1,
              orderBy: { created_at: 'desc' }
            }
          }
        },
        delivery_agent: { select: { full_name: true, phone: true } }
      }
    });

    if (!delivery || delivery.status !== 'completed') {
      return res.status(400).json({ success: false, error: 'Order is not marked as delivered.' });
    }

    if (delivery.delivery_agent_id !== delivery_officer_id) {
      return res.status(403).json({ success: false, error: 'You are not the designated delivery officer for this order.' });
    }

    // 48-hour verification (Extended from 24h)
    const delivery_time = delivery.end_time || delivery.updated_at;
    const now = new Date();
    const hoursDifference = (now.getTime() - delivery_time.getTime()) / (1000 * 60 * 60);

    if (hoursDifference > 48) {
      return res.status(400).json({ success: false, error: 'Return/Exchange period has expired (> 48 hours). Please contact the outlet directly.' });
    }

    // Must belong to an outlet
    const outlet_id = delivery.order.outlet_id;
    if (!outlet_id) {
      return res.status(400).json({ success: false, error: 'This order is not associated with an outlet.' });
    }

    // Check if an active return/exchange already exists
    const existing = await prisma.returnExchange.findFirst({
      where: { order_id: parseInt(order_id), status: 'pending' }
    });

    if (existing) {
      return res.status(400).json({ success: false, error: 'A return/exchange request is already pending for this order.' });
    }

    // Generate random 4 digit OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    // 6. Source specific delivery data prioritizing the official CashInHand receipt
    const cashRecord = delivery.order.cash_in_hand?.[0];
    const deliveryPlan = delivery.selected_plan ? (typeof delivery.selected_plan === 'string' ? JSON.parse(delivery.selected_plan) : delivery.selected_plan) : null;

    const deliveredAdvance = cashRecord ? cashRecord.amount : (deliveryPlan?.advance_payment || deliveryPlan?.advance_amount || deliveryPlan?.advancePayment || delivery.order?.advance_amount || 0);
    const productName = cashRecord?.product_name || deliveryPlan?.productName || delivery.order?.product_name;
    const imei = cashRecord?.imei_serial || delivery.product_imei;

    // Split color/variant from CashInHand snapshot first
    let color = 'N/A';
    let variant = 'N/A';
    if (cashRecord?.color_variant) {
      const parts = cashRecord.color_variant.split('|').map(s => s.trim());
      color = parts[0] || 'N/A';
      variant = parts[1] || 'N/A';
    } else {
      color = deliveryPlan?.color || deliveryPlan?.productColor || 'N/A';
      variant = deliveryPlan?.variant || deliveryPlan?.productVariant || 'N/A';
    }

    // Securely log the intent (Storing extra specs in selected_plan JSON to avoid schema conflicts)
    const returnRecord = await prisma.returnExchange.create({
      data: {
        order_id: parseInt(order_id),
        delivery_officer_id,
        outlet_id,
        type,
        status: 'pending',
        otp,
        product_name: productName,
        // Robust storage of snapshot specs
        selected_plan: {
          ...deliveryPlan,
          delivered_color: color,
          delivered_variant: variant,
          delivered_advance_amount: parseFloat(deliveredAdvance) || 0
        },
        imei_returned: imei,
        is_cash_refund: !!is_cash_refund,
        refund_amount: parseFloat(refund_amount) || 0,
        initiated_by: "DeliveryOfficer"
      }
    });

    // Send OTP to Delivery Officer via WhatsApp (Wati)
    const officerPhone = delivery.delivery_agent?.phone;
    const officerName = delivery.delivery_agent?.full_name || 'Officer';
    if (officerPhone) {
      try {
        await sendOTP(officerPhone, otp);
        console.log(`Return/Exchange OTP ${otp} sent to officer ${officerName} at ${officerPhone}`);
      } catch (err) {
        console.error('Error sending Return/Exchange OTP to officer:', err);
      }
    }

    // Emit socket event to outlet room so the popup opens
    const io = req.app.get('io');
    if (io) {
      io.to(`outlet_${outlet_id}`).emit('return_exchange_requested', {
        record_id: returnRecord.id,
        officer_name: officerName,
        type,
        otp,
        order_ref: delivery.order.order_ref || `#${order_id}`,
        product_name: productName,
        color: color,
        variant: variant,
        delivered_advance: deliveredAdvance,
        imei: imei || null,
        is_cash_refund: returnRecord.is_cash_refund,
        refund_amount: returnRecord.refund_amount
      });
    }

    return res.json({
      success: true,
      message: `${type} request initiated successfully. Please hand over the item to the outlet and provide this OTP.`,
      otp,
      data: returnRecord
    });
  } catch (error) {
    console.error('initiateReturnExchange error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
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
  submitCashToOutlet,
  initiateReturnExchange
};
