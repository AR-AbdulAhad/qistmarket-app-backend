const prisma = require('../../lib/prisma');
const { logOrderStatusChange } = require('../utils/orderAuditLogger');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { saveOTP, verifyOTP } = require('../utils/otpUtils');
const { sendDeliveryConfirmation } = require('../services/watiService');
const { sendOtp: sendOTP, isJazzEnabled } = require('../services/otpDispatcher');
const jazzSmsService = require('../services/jazzSmsService');
const { updateDeliveryRanking } = require('../services/deliveryRankingService');
const { notifyUser, notifyAdmins, notifyOutlet } = require('../utils/notificationUtils');
const { updateCashRegister } = require('../utils/cashRegisterUtils');
const admin = require('firebase-admin');
const { generateConsumerNumber, generateSmartPayConsumerNumber } = require('../utils/consumerNumberUtils');
const { createOfficerTransaction } = require('../utils/officerTransactionUtils');
const qrcode = require('qrcode');
const pt = require('../services/paytriggerService');
const deliveryCompletionService = require('../services/deliveryCompletionService');


// ─── Firebase Init ────────────────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
// ─────────────────────────────────────────────────────────────────
// Helper for current timestamp
const now = () => new Date();


// ─── Cash Submission OTP Notification Helper ──────────────────────────────────

async function sendCashSubmissionOTPNotification(user, otp, io = null) {
  const title = 'Cash Submission OTP';
  const message = `Your Cash Submission OTP is: ${otp}`;
  const notificationType = 'cash_submission_otp';

  if (user?.id) {
    await notifyUser(user.id, title, message, notificationType, null, io);
  }

  if (!user?.fcm_token) return;
  try {
    await admin.messaging().send({
      token: user.fcm_token,
      notification: { title, body: message },
      data: {
        type: notificationType,
        otp: otp
      },
    });
  } catch (fcmError) {
    console.error('FCM send failed for cash submission OTP:', fcmError);
  }
}

const LEDGER_TOKEN_SECRET = process.env.LEDGER_TOKEN_SECRET;
const LEDGER_BASE_URL = (process.env.LEDGER_BASE_URL || 'https://qistmarket.pk').replace(/\/$/, '');

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
  const { order_id, product_imei, selected_plan, phone, feedback, enroll_paytrigger } = req.body;

  if (!order_id) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'order_id is required' }
    });
  }

  try {
    // Check cash limit
    const limitRecord = await prisma.cashLimit.findUnique({
      where: { scope_type_scope_id: { scope_type: 'officer', scope_id: req.user.id } }
    });

    if (limitRecord) {
      const cashPendingGroup = await prisma.cashInHand.groupBy({
        by: ['officer_id'],
        where: { officer_id: req.user.id, status: 'pending' },
        _sum: { amount: true, submitted_amount: true },
      });

      const cashPending = cashPendingGroup.length
        ? (cashPendingGroup[0]._sum.amount || 0) - (cashPendingGroup[0]._sum.submitted_amount || 0)
        : 0;

      if (cashPending >= limitRecord.daily_limit) {
        return res.status(400).json({
          success: false,
          error: { code: 400, message: 'Cash limit reached. Please submit your cash in hand to proceed.' }
        });
      }
    }

    // Check if order exists and is assigned to the current user
    const order = await prisma.order.findUnique({
      where: {
        id: parseInt(order_id),
        delivery_officer_id: req.user.id
      },
      include: {
        delivery: true,
        verification: { include: { purchaser: true } },
        outlet: true
      }
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Order not found or not assigned to you' }
      });
    }

    if (order.delivery) {
      // Also covers the PayTrigger-gated case: a placeholder Delivery row already
      // exists (status = awaiting_paytrigger_enrollment), so re-submission is blocked
      // the same way a completed delivery blocks re-submission.
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Delivery already submitted for this order' }
      });
    }

    // Update purchaser phone number if provided
    if (phone && order.verification?.purchaser) {
      await prisma.purchaserVerification.update({
        where: { id: order.verification.purchaser.id },
        data: { telephone_number: phone }
      });
      order.verification.purchaser.telephone_number = phone;
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

    // Read-only inventory snapshot — used both for PayTrigger gating and as the
    // product name/category passed down to the completion logic.
    let productNameSnapshot = null;
    let inventoryCategory = null;
    if (product_imei) {
      const inventory = await prisma.outletInventory.findFirst({ where: { imei_serial: product_imei } });
      productNameSnapshot = inventory?.product_name || null;
      inventoryCategory = inventory?.category || null;
    }

    const { gateRequired } = deliveryCompletionService.resolvePaytriggerGate({
      enrollPaytriggerFlag: enroll_paytrigger,
      product_imei,
      productNameSnapshot,
      inventoryCategory,
    });

    const io = req.app.get('io');
    const payload = {
      order_id: order.id,
      product_imei: product_imei || null,
      selected_plan: selected_plan || null,
      feedback: feedback || null,
      custom_ledger: req.body.custom_ledger || null,
      uploads: {
        facePhotos: facePhotos.map((f, i) => ({ url: f.url, tag: faceTags[i] || null })),
        locationPhotos: locationPhotos.map((f, i) => ({ url: f.url, tag: locationTags[i] || null })),
        housePhotos: housePhotos.map((f, i) => ({ url: f.url, tag: houseTags[i] || null })),
        locationLinks: locationLinks.map((link, i) => ({ link, tag: linkTags[i] || null })),
      },
      user: {
        id: req.user.id,
        full_name: req.user.full_name,
        username: req.user.username,
        phone: req.user.phone,
        role: req.user.role,
        role_id: req.user.role_id,
      },
    };

    if (gateRequired) {
      let gateResult;
      try {
        gateResult = await deliveryCompletionService.initiateGatedDelivery({
          mode: 'agent', order, payload, io, productNameSnapshot, inventoryCategory,
        });
      } catch (gateErr) {
        console.error('[PayTrigger] initiateGatedDelivery failed:', gateErr.message);
        return res.status(502).json({
          success: false,
          error: { code: 502, message: 'PayTrigger enrollment could not be started. Please retry.' },
          paytrigger_error: gateErr.paytriggerResult || gateErr.message,
        });
      }

      if (gateResult.completedImmediately) {
        return res.status(201).json({
          success: true,
          message: 'Delivery submitted successfully',
          data: { delivery: gateResult.delivery, ledger_url: null },
        });
      }

      return res.status(202).json({
        success: true,
        status: deliveryCompletionService.PENDING_STATUS,
        message: 'Delivery initiated. Waiting for PayTrigger device enrollment confirmation.',
        data: { delivery: gateResult.delivery, paytrigger: gateResult.paytriggerDevice },
      });
    }

    const { delivery: updatedDelivery, ledgerUrl } = await deliveryCompletionService.completeAgentDelivery({
      order, payload, io, productNameSnapshot, inventoryCategory,
    });

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
        uploads: true,
        // Surfaces enrollment/device state so the frontend can render the
        // PayTrigger processing screen without a separate request.
        paytrigger_devices: {
          orderBy: { updated_at: 'desc' },
          take: 1,
          select: {
            imei: true,
            device_tag: true,
            enrollment_status: true,
            server_state: true,
            lock_status: true,
            product_model: true,
            last_sync_at: true,
          }
        }
      }
    });

    if (!delivery) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Delivery not found for this order' }
      });
    }

    // pending_payload is an internal implementation detail (raw request snapshot
    // used to finish a PayTrigger-gated delivery) — never expose it to clients.
    const { pending_payload, ...deliverySafe } = delivery;

    return res.status(200).json({
      success: true,
      data: { delivery: deliverySafe }
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
  // ... unchanged (read-only)
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
  // ... unchanged (read-only)
  const { date_from, date_to, status, date } = req.query;
  const deliveryBoyId = req.user?.id;

  try {
    let where = {
      officer_id: deliveryBoyId,
    };

    // SPECIAL CASE: Agar sirf pending dekhna hai
    if (status === 'pending') {
      where.status = 'pending';
    }
    // SPECIAL CASE: Jab koi bhi filter apply nahi hai
    else if (!date && !date_from && !date_to && !status) {
      // Sab kuch dikhao - koi date filter nahi
    }
    // Normal case: Filters apply hain
    else {
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
          }
        },
        outlet: {
          select: { name: true, code: true }
        },
        submission_history: {
          where: { status: 'paid' },
          orderBy: { submission_date: 'desc' }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    // === TRANSACTION HISTORY (From unified OfficerTransaction table) ===
    let txWhere = { officer_id: deliveryBoyId };
    if (status) txWhere.status = status;
    if (where.created_at) txWhere.transaction_date = where.created_at;

    const rawTransactions = await prisma.officerTransaction.findMany({
      where: txWhere,
      orderBy: { transaction_date: 'desc' }
    });

    // We can group debits by submission_ref for display, similar to the old behavior
    const groupedHistory = [];
    const debitsByRef = {};

    rawTransactions.forEach(item => {
      if (item.type === 'credit') {
        groupedHistory.push(item);
      } else {
        const ref = item.submission_ref || `individual_${item.id}`;
        if (!debitsByRef[ref]) {
          debitsByRef[ref] = {
            ...item,
            amount: 0,
            order_refs: new Set()
          };
          groupedHistory.push(debitsByRef[ref]);
        }
        debitsByRef[ref].amount += item.amount;
        if (item.order_ref && item.order_ref !== 'N/A') {
          debitsByRef[ref].order_refs.add(item.order_ref);
        }
      }
    });

    groupedHistory.forEach(item => {
      if (item.type === 'debit' && item.order_refs) {
        const refsArray = Array.from(item.order_refs);
        if (refsArray.length > 1) {
          item.description = `Combined submission for ${refsArray.length} orders`;
          item.order_ref = refsArray.join(', ');
        } else if (refsArray.length === 1) {
          item.order_ref = refsArray[0];
        }
        delete item.order_refs;
      }
    });

    // Re-sort ascending to calculate chronological running balance
    groupedHistory.sort((a, b) => new Date(a.transaction_date).getTime() - new Date(b.transaction_date).getTime());

    let runBal = 0;
    groupedHistory.forEach(item => {
      if (item.type === 'credit') {
        runBal += item.amount;
      } else if (item.type === 'debit' && item.status === 'paid') {
        runBal -= item.amount;
      }
      item.balance = runBal;
    });

    // Re-sort descending for display (newest first)
    groupedHistory.sort((a, b) => new Date(b.transaction_date).getTime() - new Date(a.transaction_date).getTime());

    // Calculate totals and running balance correctly
    const totalCredits = cashEntries.reduce((sum, e) => sum + e.amount, 0);
    const totalDebits = cashEntries.reduce((sum, e) => sum + (e.submitted_amount || 0), 0);
    const currentBalance = totalCredits - totalDebits;

    const totalUnpaid = cashEntries
      .filter(e => e.status === 'pending')
      .reduce((sum, e) => sum + (e.amount - (e.submitted_amount || 0)), 0);

    // Cash-in-hand limit (Admin → Cash Limits) — computed against the
    // officer's TRUE unsubmitted balance, not the (possibly date-filtered)
    // currentBalance above, same as recoveryController.getCollectionStats.
    const pendingEntries = await prisma.cashInHand.findMany({
      where: { officer_id: deliveryBoyId, status: 'pending' }
    });
    const trueCashInHand = pendingEntries.reduce((sum, e) => sum + (e.amount - (e.submitted_amount || 0)), 0);
    const limitRecord = await prisma.cashLimit.findUnique({
      where: { scope_type_scope_id: { scope_type: 'officer', scope_id: deliveryBoyId } }
    });
    const cashLimit = limitRecord ? limitRecord.daily_limit : null;
    const isLimitExceeded = limitRecord ? (trueCashInHand >= limitRecord.daily_limit) : false;

    return res.status(200).json({
      success: true,
      transaction_history: groupedHistory,
      current_balance: currentBalance,
      total_credits: totalCredits,
      total_debits: totalDebits,
      total_unpaid: totalUnpaid,
      cash_in_hand: trueCashInHand,
      cash_limit: cashLimit,
      is_limit_exceeded: isLimitExceeded
    });
  } catch (error) {
    console.error('getCashInHand error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

const submitCashToOutlet = async (req, res) => {
  const { outlet_id, payment_method, submit_amount } = req.body;
  const deliveryBoyId = req.user?.id;

  if (payment_method !== 'Online' && !outlet_id) {
    return res.status(400).json({ success: false, message: 'outlet_id is required for cash submissions' });
  }

  try {
    // 0. Check for pending submissions
    const pendingSubmission = await prisma.cashSubmissionHistory.findFirst({
      where: {
        cash_in_hand: { officer_id: deliveryBoyId },
        status: 'pending'
      }
    });

    if (pendingSubmission) {
      return res.status(400).json({ success: false, message: 'You already have a pending cash submission. Please complete it first.' });
    }

    // 1. Fetch all cash entries to calculate bank-like balance
    let availableEntries = await prisma.cashInHand.findMany({
      where: { officer_id: deliveryBoyId },
      orderBy: { created_at: 'asc' }, // FIFO: Oldest first
      include: {
        officer: { select: { id: true, full_name: true, phone: true, fcm_token: true } },
        order: { select: { product_name: true, order_ref: true } }
      }
    });

    const totalCredits = availableEntries.reduce((sum, e) => sum + e.amount, 0);
    const totalDebits = availableEntries.reduce((sum, e) => sum + (e.submitted_amount || 0), 0);
    const currentBalance = totalCredits - totalDebits;

    // ✅ No restriction — submission allowed regardless of balance (zero,
    // negative, or any amount above the calculated balance).
    let amountToSubmit = parseFloat(submit_amount);
    if (isNaN(amountToSubmit)) {
      amountToSubmit = currentBalance; // Default to full submission only when unparseable
    }

    const lastEntry = availableEntries[availableEntries.length - 1];

    // Filter out only entries that have remaining balance for FIFO distribution
    availableEntries = availableEntries.filter(e => (e.amount - (e.submitted_amount || 0)) > 0);

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const submissionRef = `SUB-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // For Online payments, validate the officer has an active gateway consumer
    // number BEFORE creating any pending records below. Previously this check
    // ran after the CashSubmissionHistory/OfficerTransaction rows were already
    // created, so a missing number left a phantom "pending" submission behind
    // that blocked all future submissions and could never be paid (no QR was
    // ever generated, so no gateway webhook would ever arrive to clear it).
    let onlineUserRecord = null;
    if (payment_method === 'Online') {
      onlineUserRecord = await prisma.user.findUnique({
        where: { id: deliveryBoyId },
        select: { bill_consumer_number: true, smart_pay_consumer_number: true }
      });

      if (!onlineUserRecord?.bill_consumer_number) {
        return res.status(400).json({ success: false, message: 'Your account does not have an active 1Bill or SmartPay number. Please contact support.' });
      }
    }

    // 2. Distribute the `amountToSubmit` across `availableEntries` (FIFO logic)
    let remainingToSubmit = amountToSubmit;
    const historyCreations = [];

    for (const entry of availableEntries) {
      if (remainingToSubmit <= 0) break;

      const availableInEntry = entry.amount - (entry.submitted_amount || 0);
      const drawAmount = Math.min(availableInEntry, remainingToSubmit);

      historyCreations.push({
        cash_in_hand_id: entry.id,
        amount_submitted: drawAmount,
        status: 'pending',
        otp: otp,
        submission_ref: submissionRef, // Group them
        outlet_id: payment_method === 'Online' ? null : parseInt(outlet_id),
        submission_date: now()   // ✅ explicit submission_date
      });

      remainingToSubmit -= drawAmount;
    }

    // If there is excess submit amount (e.g. balance is 0/negative or excess submission), link it to the last entry
    if (remainingToSubmit > 0) {
      let targetEntry = lastEntry;

      // ✅ No cash entries exist at all yet (brand new officer / balance
      // truly has nothing to link to). Wallet is allowed to go negative, so
      // create a zero-value placeholder anchored to any order this officer
      // is linked to, instead of blocking the submission outright.
      if (!targetEntry) {
        const anchorOrder = await prisma.order.findFirst({
          where: {
            OR: [
              { delivery_officer_id: deliveryBoyId },
              { recovery_officer_id: deliveryBoyId }
            ]
          },
          orderBy: { created_at: 'desc' }
        });

        if (!anchorOrder) {
          return res.status(400).json({ success: false, message: 'No cash collections found to link this submission to. Please collect some payment or deliver an order first.' });
        }

        targetEntry = await prisma.cashInHand.create({
          data: {
            officer_id: deliveryBoyId,
            order_id: anchorOrder.id,
            amount: 0,
            status: 'pending',
            customer_name: anchorOrder.customer_name,
            product_name: anchorOrder.product_name,
            created_at: now(),
            updated_at: now()
          }
        });
      }

      const existingIndex = historyCreations.findIndex(hc => hc.cash_in_hand_id === targetEntry.id);
      if (existingIndex !== -1) {
        historyCreations[existingIndex].amount_submitted += remainingToSubmit;
      } else {
        historyCreations.push({
          cash_in_hand_id: targetEntry.id,
          amount_submitted: remainingToSubmit,
          status: 'pending',
          otp: otp,
          submission_ref: submissionRef,
          outlet_id: payment_method === 'Online' ? null : parseInt(outlet_id),
          submission_date: now()
        });
      }
      remainingToSubmit = 0;
    }

    // 3. Create the CashSubmissionHistory records
    if (historyCreations.length > 0) {
      await prisma.cashSubmissionHistory.createMany({
        data: historyCreations
      });
    }

    // 3.1 Create OfficerTransaction records for debits sequentially.
    // STATUS IS ALWAYS 'pending' — only moves to 'paid' when OTP is verified by outlet.
    // This ensures the officer's balance is NOT cut until cash is physically confirmed.
    for (const hc of historyCreations) {
      await createOfficerTransaction({
        officer_id: deliveryBoyId,
        type: 'debit',
        amount: hc.amount_submitted,
        status: 'pending', // Always pending until OTP verification
        description: payment_method === 'Online' ? 'Online cash submission (awaiting payment)' : 'Cash submitted to outlet (awaiting OTP)',
        payment_method: payment_method || 'Cash',
        submission_ref: hc.submission_ref
      });
    }

    const officer = lastEntry?.officer;
    const officerName = officer?.full_name || 'Officer';
    const officerPhone = officer?.phone;

    if (payment_method === 'Online') {
      const userRecord = onlineUserRecord;

      const dueDate = new Date();
      dueDate.setHours(dueDate.getHours() + 24);

      let qrImageBase64 = null;
      try {
        const yy = String(dueDate.getFullYear()).slice(-2);
        const mm = String(dueDate.getMonth() + 1).padStart(2, '0');
        const billingMonth = `${yy}${mm}`;
        const refInfo = `QIST-${deliveryBoyId}-${Date.now()}`.substring(0, 30);
        const username = process.env.SMARTPAY_USERNAME || 'test';
        const password = process.env.SMARTPAY_PASSWORD || 'test';

        const tokenReq = await fetch(process.env.SMARTPAY_TOKEN_URL || 'https://smartpay.com.pk/services/api/v1/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const tokenResponse = await tokenReq.json();
        if (tokenResponse?.statusCode === "200" && tokenResponse?.dist?.jwtToken) {
          const dqrReq = await fetch(process.env.SMARTPAY_DQR_URL || 'https://smartpay.com.pk/services/api/v1/DQR', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `${tokenResponse.dist.jwtToken}`
            },
            body: JSON.stringify({
              Consumer_Number: userRecord.smart_pay_consumer_number,
              Consumer_Detail: officerName,
              Billing_Month: billingMonth,
              Amount: parseFloat(amountToSubmit).toFixed(2),
              CellNo: officerPhone || "",
              EMail: "",
              ReferenceInfo: refInfo,
              reserved: ""
            })
          });
          const dqrResponse = await dqrReq.json();
          if (dqrResponse?.statusCode === "200" && dqrResponse?.QrString) {
            qrImageBase64 = await qrcode.toDataURL(dqrResponse.QrString, {
              errorCorrectionLevel: 'H',
              margin: 2,
              width: 400
            });
          }
        }
      } catch (err) {
        console.error("Failed to generate SmartPay QR in submitCash:", err);
      }

      await prisma.consumerNumber.updateMany({
        where: {
          consumer_number: { in: [userRecord.bill_consumer_number, userRecord.smart_pay_consumer_number] },
          user_id: deliveryBoyId
        },
        data: {
          amount_due: amountToSubmit,
          bill_status: 'U',
          cash_submission_ref: submissionRef,
          due_date: dueDate
        }
      });

      return res.status(200).json({
        success: true,
        message: 'Online cash submission initiated.',
        total_amount: amountToSubmit,
        bill_consumer_number: userRecord.bill_consumer_number,
        smart_pay_consumer_number: userRecord.smart_pay_consumer_number,
        smart_pay_qr_base64: qrImageBase64,
        submission_ref: submissionRef,
        expires_at: dueDate
      });
    }

    // 4. Persistence & Notifications (Outlet flow)
    const otpMessage = `Your Cash Submission OTP is: ${otp}`;

    // Save to OtpLog with explicit created_at
    const otpLog = await prisma.otpLog.create({
      data: {
        user_id: deliveryBoyId,
        action: "cash_submission_otp",
        message: otpMessage,
        otp,
        created_at: now()   // ✅ explicit created_at
      }
    });

    const io = req.app.get('io');
    if (io) {
      // Real-time: Emit to Officer's room (App pickup)
      const officerRoom = `user_${deliveryBoyId}`;
      io.to(officerRoom).emit('cash_submission_otp', {
        otp_log_id: otpLog.id,
        action: otpLog.action,
        message: otpMessage,
        otp,
        created_at: otpLog.created_at
      });

      // Real-time: Notify Outlet
      io.to(`outlet_${outlet_id}`).emit('cash_submission_otp', {
        target_outlet_id: parseInt(outlet_id),
        officer_name: officerName,
        amount: amountToSubmit,
        payment_method: payment_method || 'Cash',
        otp: otp
      });

      // Save notification to DB for Outlet Users
      await notifyOutlet(
        outlet_id,
        'Cash Submission Requested',
        `${officerName} has requested to submit PKR ${amountToSubmit} to your outlet.`,
        'cash_submission_otp',
        null,
        io
      );
    }

    // Send through helper (App Push + Internal)
    await sendCashSubmissionOTPNotification(officer, otp, io);

    // Legacy: Send through WATI (WhatsApp)
    if (officerPhone) {
      sendOTP(officerPhone, otp).catch(err => console.error('WATI OTP Error:', err));
    }

    return res.status(200).json({
      success: true,
      message: 'Cash submission initiated. OTP has been sent to your App & WhatsApp.',
      total_amount: amountToSubmit
    });
  } catch (error) {
    console.error('submitCashToOutlet error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

// Cancel a pending cash submission (officer's own) — frees them up to submit
// again, since a stuck/pending submission blocks any new submission.
const cancelCashSubmission = async (req, res) => {
  const { submission_ref } = req.params;
  const deliveryBoyId = req.user?.id;

  try {
    const histories = await prisma.cashSubmissionHistory.findMany({
      where: {
        submission_ref,
        status: 'pending',
        cash_in_hand: { officer_id: deliveryBoyId }
      }
    });

    if (histories.length === 0) {
      return res.status(404).json({ success: false, message: 'No pending submission found to cancel' });
    }

    await prisma.cashSubmissionHistory.updateMany({
      where: { submission_ref, status: 'pending' },
      data: { status: 'cancelled', otp: null }
    });

    await prisma.officerTransaction.updateMany({
      where: { submission_ref, type: 'debit', status: 'pending' },
      data: { status: 'cancelled' }
    });

    // Clear the online-payment linkage too, in case this was an Online submission
    await prisma.consumerNumber.updateMany({
      where: { cash_submission_ref: submission_ref, user_id: deliveryBoyId },
      data: { cash_submission_ref: null }
    });

    return res.json({ success: true, message: 'Cash submission cancelled successfully' });
  } catch (error) {
    console.error('cancelCashSubmission error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const verifyOnlineCashSubmission = async (req, res) => {
  const { submission_ref } = req.params;
  const deliveryBoyId = req.user?.id;

  try {
    const submissions = await prisma.cashSubmissionHistory.findMany({
      where: {
        submission_ref,
        status: 'pending',
        cash_in_hand: { officer_id: deliveryBoyId }
      }
    });

    if (submissions.length === 0) {
      return res.status(404).json({ success: false, message: 'No pending submission found to verify' });
    }

    // This endpoint only checks whether the real SmartPay/1Bill webhook
    // (smartPayController.notifyPayment) already confirmed the payment —
    // it must never mark a submission paid on its own. Without this check,
    // tapping "Check/Verify Payment Status" would mark unpaid bills as paid.
    const paidConsumer = await prisma.consumerNumber.findFirst({
      where: {
        cash_submission_ref: submission_ref,
        type: 'officer_cash',
        bill_status: 'P'
      }
    });

    if (!paidConsumer) {
      return res.status(200).json({
        success: false,
        message: 'Payment not received yet. Please complete the payment via 1Bill / SmartPay first.'
      });
    }

    await prisma.cashSubmissionHistory.updateMany({
      where: { submission_ref, status: 'pending' },
      data: { status: 'paid' }
    });

    await prisma.officerTransaction.updateMany({
      where: { submission_ref, type: 'debit', status: 'pending' },
      data: {
        status: 'paid',
        transaction_date: now(),
        payment_method: 'SmartPay / 1Bill Online Payment'
      }
    });

    let totalSubmitted = 0;
    for (const sub of submissions) {
      totalSubmitted += sub.amount_submitted;
      await prisma.cashInHand.update({
        where: { id: sub.cash_in_hand_id },
        data: { submitted_amount: { increment: sub.amount_submitted } }
      });
    }

    await prisma.consumerNumber.updateMany({
      where: {
        OR: [
          { cash_submission_ref: submission_ref },
          { user_id: deliveryBoyId, type: 'officer_cash' }
        ]
      },
      data: {
        bill_status: 'P',
        amount_due: 0,
        cash_submission_ref: null,
        amount_paid: totalSubmitted,
        date_paid: now(),
        tran_auth_id: 'VERIFIED-ONLINE',
        bank_mnemonic: 'SMARTPAY',
        updated_at: now()
      }
    });

    const io = req.app.get('io');
    if (io && deliveryBoyId) {
      io.to(`user_${deliveryBoyId}`).emit('online_cash_submission_completed', {
        status: 'paid',
        amount: totalSubmitted,
        submission_ref
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Online cash submission verified successfully'
    });
  } catch (error) {
    console.error('verifyOnlineCashSubmission error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const generateDeliveryOtp = async (req, res) => {
  const { order_id, phone } = req.body;

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

    // Use provided phone if available, otherwise use purchaser phone
    const purchaserNumber = phone || order.verification.purchaser.telephone_number;

    if (!purchaserNumber) {
      return res.status(400).json({ success: false, error: { message: 'No phone number available' } });
    }

    const otp = await saveOTP(purchaserNumber, 'delivery');
    await sendOTP(purchaserNumber, otp);

    // Rich item-handover message — item/installment details, terms, the
    // delivering officer as "representative", and the SAME OTP above. Jazz
    // SMS only (moved off WATI) — fire-and-forget alongside the generic OTP
    // dispatch above, never instead of it.
    if (isJazzEnabled()) {
      jazzSmsService.sendItemHandoverSms(purchaserNumber, {
        customerName: order.verification.purchaser.name || order.customer_name,
        itemName: order.product_name,
        advanceAmount: order.advance_amount,
        installmentAmount: order.monthly_amount,
        installmentDate: String(new Date().getDate()),
        totalInstallments: order.months,
        representativeName: req.user?.full_name,
        representativeNumber: req.user?.phone,
        otp,
      }).catch(err => console.error('Jazz Item Handover Error:', err));
    }

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
  const { order_id, phone, otp, custom_ledger } = req.body;

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

    const purchaserNumber = phone || order.verification.purchaser.telephone_number;

    if (!purchaserNumber) {
      return res.status(400).json({ success: false, error: { message: 'No phone number available' } });
    }

    const verification = await verifyOTP(purchaserNumber, otp, 'delivery');
    if (!verification.valid) {
      return res.status(400).json({ success: true, valid: false, message: verification.message });
    }

    const io = req.app.get('io');

    // If custom_ledger is provided, it means we are also submitting the delivery (Admin Manual Flow)
    if (custom_ledger) {
      try {
        const parsedLedger = typeof custom_ledger === 'string' ? JSON.parse(custom_ledger) : custom_ledger;

        await prisma.$transaction(async (tx) => {
          // 1. Update Order Status with updated_at
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: 'delivered',
              is_delivered: true,
              delivered_at: now(),
              updated_at: now()   // ✅ explicit updated_at
            }
          });

          // 2. Create/Update Ledger with timestamps
          await tx.installmentLedger.upsert({
            where: { order_id: order.id },
            update: {
              ledger_rows: parsedLedger,
              updated_at: now()
            },
            create: {
              order_id: order.id,
              ledger_rows: parsedLedger,
              created_at: now(),
              updated_at: now()
            }
          });

          // 3. Mark delivery as completed if exists
          const existingDelivery = await tx.delivery.findUnique({
            where: { order_id: order.id }
          });

          if (existingDelivery) {
            await tx.delivery.update({
              where: { id: existingDelivery.id },
              data: {
                status: 'completed',
                end_time: now(),
                verified: true,
                updated_at: now()
              }
            });
          } else {
            // Create a basic delivery record if none exists (manual admin delivery)
            await tx.delivery.create({
              data: {
                order_id: order.id,
                delivery_agent_id: req.user.id,
                status: 'completed',
                start_time: now(),
                end_time: now(),
                verified: true,
                self_pickup: false,
                created_at: now(),
                updated_at: now()
              }
            });
          }
        });

        await notifyAdmins(
          'Delivery Completed (Manual)',
          `Order #${order.order_ref} marked as delivered by ${req.user.full_name}`,
          'delivery_complete',
          order.id,
          io
        );

        io?.to(`officer_${req.user.id}`).emit('delivery_data_updated', { reason: 'delivery_submitted', orderId: order.id });

        return res.status(200).json({
          success: true,
          valid: true,
          message: 'OTP verified and delivery completed successfully'
        });

      } catch (e) {
        console.error('[verifyDeliveryOtp] Finalization error:', e);
        return res.status(500).json({ success: false, error: { message: 'Failed to finalize delivery' } });
      }
    }

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
        cancelled_at: now(),
        updated_at: now()   // ✅ explicit updated_at
      }
    });

    await logOrderStatusChange(parseInt(order_id), order.status, 'returned', req.user);

    const io = req.app.get('io');
    await notifyAdmins(
      'Product Returned',
      `Product for Order #${order_id} has been returned. Reason: ${reason}`,
      'product_returned',
      order_id,
      io
    );

    io?.to(`officer_${req.user.id}`).emit('delivery_data_updated', { reason: 'product_returned', orderId: parseInt(order_id) });

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
      data: {
        status: 'refunded',
        updated_at: now()   // ✅ explicit updated_at
      }
    });

    await logOrderStatusChange(parseInt(order_id), order.status, 'refunded', req.user);

    const io = req.app.get('io');
    await notifyAdmins(
      'Refund Processed',
      `Refund for Order #${order_id} has been verified and processed`,
      'refund_processed',
      order_id,
      io
    );

    io?.to(`officer_${req.user.id}`).emit('delivery_data_updated', { reason: 'refund_processed', orderId: parseInt(order_id) });

    return res.status(200).json({ success: true, valid: true, message: 'Refund verified and processed' });
  } catch (error) {
    console.error('verifyRefundOtp error:', error);
    return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
};

const getDeliveryBoyInventory = async (req, res) => {
  // ... unchanged (read-only)
  try {
    const deliveryBoyId = req.user.id;

    const transfers = await prisma.stockTransfer.findMany({
      where: {
        to_type: 'Delivery Officer',
        to_id: deliveryBoyId,
        status: { in: ['transferred'] }
      },
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
            installment_plans: true,
            sale_price: true,
            api_product_name: true
          }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    console.log('Fetched transfers:', transfers);

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
          sale_price: t.inventory.sale_price || null,
          api_product_name: t.inventory.api_product_name || null,
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
        status: 'In Stock',
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

// const pickOrder = async (req, res) => {
//   ... (commented out)
// };

const unpickOrder = async (req, res) => {
  const { order_id, feedback } = req.body;

  try {
    if (!order_id) {
      return res.status(404).json({ success: false, error: { message: 'Order not found' } });
    }

    if (!feedback) {
      return res.status(400).json({ success: false, error: { message: 'Feedback/reason is required' } });
    }

    await prisma.order.update({
      where: { id: parseInt(order_id) },
      data: {
        status: 'postponed',
        postponed_feedback: feedback,
        updated_at: now()   // ✅ explicit updated_at
      }
    });

    await logOrderStatusChange(parseInt(order_id), 'picked', 'postponed', req.user);

    const io = req.app.get('io');
    await notifyAdmins(
      'Order Postponed',
      `Order #${order_id} has been unpicked and postponed. Reason: ${feedback}`,
      'order_unpicked',
      order_id,
      io
    );

    const order = await prisma.order.findUnique({ where: { id: parseInt(order_id) } });
    if (order?.outlet_id) {
      await notifyOutlet(
        order.outlet_id,
        'Order Postponed',
        `Order #${order.order_ref} has been postponed by the officer. Reason: ${feedback}`,
        'order_unpicked',
        order.id,
        io
      );
    }

    io?.to(`officer_${req.user.id}`).emit('delivery_data_updated', { reason: 'order_unpicked', orderId: parseInt(order_id) });

    return res.status(200).json({ success: true, message: 'Order has been postponed successfully', feedback });
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
    const nowDate = now();
    const hoursDifference = (nowDate.getTime() - delivery_time.getTime()) / (1000 * 60 * 60);

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
        initiated_by: "DeliveryOfficer",
        created_at: now()   // ✅ explicit created_at
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

      // Save notification to DB for Outlet Users
      await notifyOutlet(
        outlet_id,
        `${type} Requested`,
        `${officerName} has requested a ${type} for Order #${delivery.order.order_ref}.`,
        'return_exchange_requested',
        returnRecord.id,
        io
      );
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

const getDeliveryOfficerOTPLogs = async (req, res) => {
  const deliveryBoyId = req.user?.id;

  if (!deliveryBoyId) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  try {
    const logs = await prisma.otpLog.findMany({
      where: {
        user_id: deliveryBoyId,
        action: { in: ["stock_transfer_otp", "cash_submission_otp"] }
      },
      orderBy: { created_at: 'desc' }
    });

    return res.status(200).json({
      success: true,
      data: logs
    });
  } catch (error) {
    console.error('getDeliveryOfficerOTPLogs error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error while fetching OTP logs' });
  }
};

/**
 * POST /orders/self-pickup/submit
 * Handles Self Pickup delivery directly from the branch
 */
const submitSelfPickupDelivery = async (req, res) => {
  const { order_id, product_imei, selected_plan, phone, feedback, enroll_paytrigger } = req.body;
  const outlet_id = req.user.outlet_id;

  if (!outlet_id) {
    return res.status(403).json({ success: false, message: 'Not an outlet user.' });
  }

  if (!order_id) {
    return res.status(400).json({ success: false, message: 'order_id is required' });
  }

  try {
    // 1. Fetch Order and Verify Outlet
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        delivery: true,
        verification: { include: { purchaser: true } },
        outlet: true
      }
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.outlet_id !== outlet_id) {
      return res.status(403).json({ success: false, message: 'Order does not belong to your outlet' });
    }

    if (order.delivery) {
      if (order.delivery.status === 'awaiting_paytrigger_enrollment' || order.is_delivered || order.status === 'delivered' || order.status === 'completed') {
        return res.status(400).json({ success: false, message: 'Delivery already submitted and completed for this order' });
      }
      // Stale or non-completed delivery record on an approved order — clean it up so self-pickup can proceed
      try {
        await prisma.deliveryUpload.deleteMany({ where: { delivery_id: order.delivery.id } });
        await prisma.delivery.delete({ where: { id: order.delivery.id } });
      } catch (delErr) {
        console.error('Error cleaning up stale delivery record before self-pickup:', delErr);
      }
    }

    // 2. Update purchaser phone number if provided
    if (phone && order.verification?.purchaser) {
      await prisma.purchaserVerification.update({
        where: { id: order.verification.purchaser.id },
        data: { telephone_number: phone }
      });
      order.verification.purchaser.telephone_number = phone;
    }

    // 2.1 Process face photo
    const facePhotos = req.files['face_photo'] || [];

    // Read-only inventory snapshot — used both for PayTrigger gating and as the
    // product name/category passed down to the completion logic.
    let productNameSnapshot = order.product_name;
    let inventoryCategory = null;
    if (product_imei) {
      const inventory = await prisma.outletInventory.findFirst({ where: { imei_serial: product_imei, outlet_id } });
      if (inventory) {
        productNameSnapshot = inventory.product_name;
        inventoryCategory = inventory.category;
      }
    }

    const { gateRequired } = deliveryCompletionService.resolvePaytriggerGate({
      enrollPaytriggerFlag: enroll_paytrigger,
      product_imei,
      productNameSnapshot,
      inventoryCategory,
    });

    const io = req.app.get('io');
    const payload = {
      order_id: order.id,
      outlet_id,
      product_imei: product_imei || null,
      selected_plan: selected_plan || null,
      feedback: feedback || null,
      custom_ledger: req.body.custom_ledger || null,
      uploads: {
        facePhotos: facePhotos.map((f) => ({ url: f.url || f.path })),
      },
      user: {
        id: req.user.id,
        full_name: req.user.full_name,
        username: req.user.username,
        phone: req.user.phone,
        role: req.user.role,
        role_id: req.user.role_id,
      },
    };

    if (gateRequired) {
      let gateResult;
      try {
        gateResult = await deliveryCompletionService.initiateGatedDelivery({
          mode: 'self_pickup', order, payload, io, productNameSnapshot, inventoryCategory,
        });
      } catch (gateErr) {
        console.error('[PayTrigger] initiateGatedDelivery failed:', gateErr.message);
        return res.status(502).json({
          success: false,
          message: 'PayTrigger enrollment could not be started. Please retry.',
          paytrigger_error: gateErr.paytriggerResult || gateErr.message,
        });
      }

      if (gateResult.completedImmediately) {
        return res.status(201).json({
          success: true,
          message: 'Self Pickup processed successfully',
          data: { delivery: gateResult.delivery, ledger_url: null },
        });
      }

      return res.status(202).json({
        success: true,
        status: deliveryCompletionService.PENDING_STATUS,
        message: 'Self Pickup initiated. Waiting for PayTrigger device enrollment confirmation.',
        data: { delivery: gateResult.delivery, paytrigger: gateResult.paytriggerDevice },
      });
    }

    const { delivery, ledgerUrl } = await deliveryCompletionService.completeSelfPickupDelivery({
      order, payload, io, productNameSnapshot, inventoryCategory,
    });

    return res.status(201).json({
      success: true,
      message: 'Self Pickup processed successfully',
      data: { delivery, ledger_url: ledgerUrl }
    });

  } catch (error) {
    console.error('submitSelfPickupDelivery error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Replace a delivery upload photo (Super Admin only)
const replaceDeliveryUpload = async (req, res) => {
  const { upload_id } = req.params;

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  try {
    const existing = await prisma.deliveryUpload.findUnique({
      where: { id: parseInt(upload_id) }
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Upload not found' });
    }

    const updated = await prisma.deliveryUpload.update({
      where: { id: parseInt(upload_id) },
      data: {
        file_url: req.file.url,
        uploaded_at: now()
      },
      include: {
        delivery: {
          include: {
            order: {
              include: {
                verification: true
              }
            }
          }
        }
      }
    });

    // Log to edit history (if verification exists)
    if (updated.delivery.order.verification) {
      await prisma.verificationEditHistory.create({
        data: {
          verification_id: updated.delivery.order.verification.id,
          entity_type: 'delivery_upload',
          entity_id: updated.id,
          field_name: 'file_url',
          old_value: existing.file_url,
          new_value: updated.file_url,
          edited_by_id: req.user.id,
          edited_by_name: req.user.full_name,
          edited_at: now()
        }
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Delivery upload replaced successfully',
      data: { upload: updated }
    });
  } catch (error) {
    console.error('Replace delivery upload error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

const getDeliveryDashboardStats = async (req, res) => {
  try {
    const { filter = 'today', startDate, endDate } = req.query;
    const userId = req.user.id;

    // Trigger async ranking update
    updateDeliveryRanking(userId, 'today').catch(err => console.error('Auto-ranking update error:', err));
    updateDeliveryRanking(userId, 'month').catch(err => console.error('Auto-ranking update error:', err));

    const nowDt = new Date();
    let start, end;

    if (filter === 'today') {
      start = new Date(nowDt); start.setHours(0, 0, 0, 0);
      end = new Date(nowDt); end.setHours(23, 59, 59, 999);
    } else if (filter === 'month') {
      start = new Date(nowDt.getFullYear(), nowDt.getMonth(), 1, 0, 0, 0, 0);
      end = new Date(nowDt.getFullYear(), nowDt.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (filter === 'custom' && startDate && endDate) {
      start = new Date(startDate); start.setHours(0, 0, 0, 0);
      end = new Date(endDate); end.setHours(23, 59, 59, 999);
    } else {
      start = new Date(nowDt); start.setHours(0, 0, 0, 0);
      end = new Date(nowDt); end.setHours(23, 59, 59, 999);
    }

    const dateFilter = { gte: start, lte: end };

    // ─── 1. MY ORDERS in period ──────────────────────────────────────────────
    const myOrders = await prisma.order.findMany({
      where: {
        delivery_officer_id: userId,
        updated_at: dateFilter,
      },
      select: {
        id: true,
        status: true,
        total_amount: true,
        customer_id: true,
        channel: true,
      }
    });

    let assignedOrders = myOrders.length;
    let deliveredOrders = 0;
    let newDeliveries = 0;
    let cancelledCount = 0;
    let rejectedCount = 0;
    let expiredCount = 0;
    let postponedCount = 0;
    let deliveredSalesAmount = 0;
    const uniqueCustomerIds = new Set();
    const channelMap = {};

    myOrders.forEach(o => {
      const status = o.status;
      if (status === 'delivered') {
        deliveredOrders++;
        deliveredSalesAmount += (o.total_amount || 0);
        if (o.customer_id) uniqueCustomerIds.add(o.customer_id);
      }
      if (status === 'new' || status === 'pending') newDeliveries++;
      if (status === 'cancelled') cancelledCount++;
      if (status === 'rejected') rejectedCount++;
      if (status === 'expired') expiredCount++;
      if (status === 'postponed') postponedCount++;

      // Channel breakdown from orders directly
      const ch = (o.channel || 'unknown').toLowerCase();
      if (!channelMap[ch]) channelMap[ch] = { total: 0, delivered: 0, cancelled: 0 };
      channelMap[ch].total += 1;
      if (status === 'delivered') channelMap[ch].delivered += 1;
      if (status === 'cancelled') channelMap[ch].cancelled += 1;
    });

    const customersDone = deliveredOrders; // Do not use uniqueCustomerIds as requested

    // ─── 2. Home location required ───────────────────────────────────────────
    const orderIds = myOrders.map(o => o.id);
    let homeLocationRequired = 0;
    if (orderIds.length > 0) {
      homeLocationRequired = await prisma.verification.count({
        where: { order_id: { in: orderIds }, home_location_required: true }
      });
    }

    // ─── 3. Officer profile info & Working Hours (from officer_profile_history) ──
    const officerInfo = await prisma.user.findUnique({
      where: { id: userId },
      select: { officer_profile_history: true }
    });

    let bikeRange = 0;
    let totalWorkingSeconds = 0;

    if (officerInfo?.officer_profile_history) {
      const history = Array.isArray(officerInfo.officer_profile_history)
        ? officerInfo.officer_profile_history
        : [];

      history.forEach(entry => {
        // ── Working Hours: filter by actual session date (working_hours_start) ──
        const wsStart = entry.updated?.working_hours_start
          ? new Date(entry.updated.working_hours_start)
          : null;
        const wsEnd = entry.updated?.working_hours_end
          ? new Date(entry.updated.working_hours_end)
          : null;

        if (wsStart && wsStart >= start && wsStart <= end) {
          if (wsEnd && wsEnd > wsStart) {
            totalWorkingSeconds += (wsEnd - wsStart) / 1000; // accurate to the second
          }
        }

        // ── Bike KM: filter by updatedAt, take positive delta ──────────────────
        const entryDate = new Date(entry.updatedAt);
        if (entryDate >= start && entryDate <= end) {
          const prevKm = Number(entry.previous?.bike_km_range || 0);
          const updKm = Number(entry.updated?.bike_km_range || 0);
          const delta = updKm - prevKm;
          if (delta > 0) bikeRange += delta;
        }
      });
    }

    const workingHoursNum = totalWorkingSeconds > 0
      ? Number((totalWorkingSeconds / 3600).toFixed(2))
      : 0;

    // ─── 4. Stock Value & Qty ─────────────────────────────────────────────────
    const stockTransfers = await prisma.stockTransfer.findMany({
      where: {
        to_type: 'Delivery Officer',
        to_id: userId,
        status: { in: ['transferred', 'pending'] }
      },
      include: { inventory: true }
    });

    let stockValue = 0;
    let stockQty = 0;
    stockTransfers.forEach(st => {
      const qty = st.quantity_transferred || 0;
      const price = st.inventory?.installment_price || st.inventory?.sale_price || st.inventory?.purchase_price || 0;
      stockQty += qty;
      stockValue += price * qty;
    });
    if (stockQty < 0) stockQty = 0;
    if (stockValue < 0) stockValue = 0;

    // ─── 5. Cash In Hand ──────────────────────────────────────────────────────
    const cashEntries = await prisma.cashInHand.findMany({
      where: { officer_id: userId, status: { in: ['pending', 'partial'] } }
    });
    const totalCashInHand = cashEntries.reduce((sum, c) => {
      return sum + ((c.amount || 0) - (c.submitted_amount || 0));
    }, 0);

    // Cash-in-hand limit (Admin → Cash Limits) — same lookup as getCashInHand,
    // duplicated here because the mobile dashboard's Cash In Hand tile reads
    // from THIS endpoint, not getCashInHand (a separate detail screen).
    const cashLimitRecord = await prisma.cashLimit.findUnique({
      where: { scope_type_scope_id: { scope_type: 'officer', scope_id: userId } }
    });
    const cashLimit = cashLimitRecord ? cashLimitRecord.daily_limit : null;
    const isCashLimitExceeded = cashLimitRecord ? (totalCashInHand >= cashLimitRecord.daily_limit) : false;

    // ─── 6. Rankings: ALL delivery officers, computed live ────────────────────
    const rankingPeriod = filter === 'custom' ? 'month' : filter;

    // Get all Delivery Agent users
    const allDeliveryOfficers = await prisma.user.findMany({
      where: { role: { name: { contains: 'Delivery' } } },
      select: { id: true, username: true, full_name: true, outlet: { select: { name: true } } }
    });

    const allOfficerIds = allDeliveryOfficers.map(o => o.id);

    // Get their orders in the period
    const allOfficerOrders = await prisma.order.findMany({
      where: {
        delivery_officer_id: { in: allOfficerIds },
        updated_at: dateFilter
      },
      select: {
        delivery_officer_id: true,
        status: true,
        total_amount: true,
        customer_id: true,
      }
    });

    // Also load DB rankings as fallback for officers with no orders this period
    const dbRankings = await prisma.deliveryRanking.findMany({
      where: {
        officer_id: { in: allOfficerIds },
        period: rankingPeriod,
        month: rankingPeriod === 'month' ? nowDt.getMonth() + 1 : 0,
        year: rankingPeriod === 'month' ? nowDt.getFullYear() : 0,
      },
      include: { user: { include: { outlet: true } } }
    });
    const dbRankingMap = {};
    dbRankings.forEach(r => { dbRankingMap[r.officer_id] = r; });

    // Group live orders by officer
    const liveMap = {};
    allOfficerOrders.forEach(o => {
      const oid = o.delivery_officer_id;
      if (!liveMap[oid]) {
        liveMap[oid] = {
          delivered: 0,
          completed: 0,
          cancelled: 0,
          expired: 0,
          totalSales: 0,
          uniqueCustomers: new Set(),
          hasData: false,
        };
      }
      liveMap[oid].hasData = true;
      if (o.status === 'delivered') liveMap[oid].delivered++;
      if (o.status === 'completed') liveMap[oid].completed++;
      if (o.status === 'delivered' || o.status === 'completed') {
        liveMap[oid].totalSales += (o.total_amount || 0);
        if (o.customer_id) liveMap[oid].uniqueCustomers.add(o.customer_id);
      }
      if (o.status === 'cancelled') liveMap[oid].cancelled++;
      if (o.status === 'expired') liveMap[oid].expired++;
    });

    // Compute score for every officer
    let officerRankData = allDeliveryOfficers.map(officer => {
      const live = liveMap[officer.id];
      const db = dbRankingMap[officer.id];

      // Use live data if we have any orders this period, else DB
      const delivered = live?.delivered ?? (db?.delivered_customers || 0);
      const completed = live?.completed ?? (db?.completed_customers || 0);
      const cancelled = live?.cancelled ?? (db?.cancelled_customers || 0);
      const expired = live?.expired ?? (db?.expired_customers || 0);
      const uniqueCustomers = live?.hasData
        ? live.uniqueCustomers.size
        : (db?.unique_customers || delivered);
      const totalSales = live?.hasData
        ? live.totalSales
        : (db?.total_sales || 0);
      const score = (delivered * 10) + (completed * 5) - (cancelled * 2) - (expired * 3);

      let league = 'Bronze';
      if (score >= 300) league = 'Diamond';
      else if (score >= 100) league = 'Gold';
      else if (score >= 30) league = 'Silver';

      const outletName = officer.outlet?.name ||
        (db && dbRankingMap[officer.id]?.user?.outlet?.name) ||
        'Main';

      return {
        officerId: officer.id,
        name: officer.username || officer.full_name || 'Officer',
        outletName,
        score,
        league,
        delivered,
        uniqueCustomers,
        totalSales,
        isMe: officer.id === userId
      };
    });

    officerRankData.sort(
      (a, b) => b.uniqueCustomers - a.uniqueCustomers || b.score - a.score
    );

    let currentRank = 1;
    const officerRanking = officerRankData.map((r, i) => {
      if (i > 0 && r.uniqueCustomers < officerRankData[i - 1].uniqueCustomers) {
        currentRank = i + 1;
      }
      return {
        rank: currentRank,
        name: r.name,
        outletName: r.outletName,
        score: r.score,
        league: r.league,
        delivered: r.delivered,
        uniqueCustomers: r.uniqueCustomers,
        totalSales: r.totalSales,
        isMe: r.isMe
      };
    });

    // ─── 7. Target Tracking ───────────────────────────────────────────────────
    const currentMonthStr = `${nowDt.getFullYear()}-${String(nowDt.getMonth() + 1).padStart(2, '0')}`;
    const targetRecord = await prisma.officerTarget.findUnique({
      where: { officer_id_month: { officer_id: userId, month: currentMonthStr } }
    });

    const monthlyTarget = targetRecord?.target_amount || 0;
    const customerTarget = targetRecord?.target_customers || 0;
    const remainingAmount = Math.max(0, monthlyTarget - deliveredSalesAmount);
    const remainingCustomers = Math.max(0, customerTarget - customersDone);

    // ─── 8. Source success rate ───────────────────────────────────────────────
    const buildChannelStats = (names) => {
      const combined = { total: 0, delivered: 0, cancelled: 0 };
      names.forEach(n => {
        const data = channelMap[n.toLowerCase()];
        if (data) {
          combined.total += data.total;
          combined.delivered += data.delivered;
          combined.cancelled += data.cancelled;
        }
      });
      combined.successRate = combined.total > 0 ? Math.round((combined.delivered / combined.total) * 100) : 0;
      combined.cancelRate = combined.total > 0 ? Math.round((combined.cancelled / combined.total) * 100) : 0;
      return combined;
    };

    const sourceSuccessRate = {
      referral: buildChannelStats(['referral', 'outlet referral', 'outlet']),
      call: buildChannelStats(['call']),
      whatsapp: buildChannelStats(['whatsapp', 'whats_app', 'whats app']),
      website: buildChannelStats(['website']),
    };

    return res.status(200).json({
      success: true,
      data: {
        assignedOrders,
        deliveredOrders,
        newDeliveries,
        homeLocationRequired,
        cancelledCount,
        rejectedCount,
        expiredCount,
        postponedCount,
        bikeRange,
        workingHours: workingHoursNum,
        customersDone,
        stockValue,
        stockQty,
        cashInHand: totalCashInHand,
        cashLimit,
        isCashLimitExceeded,
        deliveredSalesAmount,
        officerRanking,
        targetTracking: {
          achievedAmount: deliveredSalesAmount,
          targetAmount: monthlyTarget,
          remainingAmount,
          achievedCustomers: customersDone,
          targetCustomers: customerTarget,
          remainingCustomers
        },
        sourceSuccessRate
      }
    });

  } catch (error) {
    console.error('getDeliveryDashboardStats error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  getDeliveryDashboardStats,
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
  // pickOrder,
  unpickOrder,
  submitCashToOutlet,
  cancelCashSubmission,
  verifyOnlineCashSubmission,
  initiateReturnExchange,
  getDeliveryOfficerOTPLogs,
  submitSelfPickupDelivery,
  replaceDeliveryUpload
};