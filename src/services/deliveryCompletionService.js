/**
 * Shared delivery-completion logic used by both the immediate (non-PayTrigger) flow
 * and the PayTrigger-gated flow (initiated by submitDelivery/submitSelfPickupDelivery,
 * finished by the PayTrigger webhook once the device reports ACTIVE).
 *
 * The functions here are the single source of truth for "what happens when a delivery
 * is completed" — order status, cash-in-hand, installment ledger, consumer numbers,
 * WATI messages, and notifications. Both deliveryController.js (immediate path) and
 * paytriggerController.js (webhook-triggered path) call into this module so the two
 * flows can never produce different final records.
 */
const prisma = require('../../lib/prisma');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { logOrderStatusChange } = require('../utils/orderAuditLogger');
const { sendDeliveryConfirmation, sendCustomerLedger } = require('../services/watiService');
const { notifyAdmins, notifyOutlet } = require('../utils/notificationUtils');
const { updateCashRegister } = require('../utils/cashRegisterUtils');
const { generateConsumerNumber, generateSmartPayConsumerNumber } = require('../utils/consumerNumberUtils');
const { createOfficerTransaction } = require('../utils/officerTransactionUtils');
const { getNormalizedLedger } = require('../utils/ledgerUtils');
const { sendAccountAwarenessForOrder } = require('../utils/accountAwarenessUtils');
const pt = require('../services/paytriggerService');

const now = () => new Date();

const LEDGER_TOKEN_SECRET = process.env.LEDGER_TOKEN_SECRET;

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

const PENDING_STATUS = 'awaiting_paytrigger_enrollment';
const COMPLETING_STATUS = 'completing';

// ─── Shared helpers ───────────────────────────────────────────────────────

function parsePlan(selected_plan) {
  if (!selected_plan) return null;
  try {
    return typeof selected_plan === 'string' ? JSON.parse(selected_plan) : selected_plan;
  } catch (e) {
    console.error('Error parsing selected_plan:', e);
    return null;
  }
}

function parseCustomLedger(custom_ledger) {
  if (!custom_ledger) return null;
  try {
    return typeof custom_ledger === 'string' ? JSON.parse(custom_ledger) : custom_ledger;
  } catch (e) {
    return null;
  }
}

/**
 * Predicts the first installment due date from the plan/custom ledger, without
 * building the full ledger. Used to pass an `expiration` to PayTrigger pre-enrollment
 * *before* the real ledger exists (ledger creation is deferred until actual completion).
 * Mirrors the ledgerRows[1].due_date derivation used when building the real ledger.
 */
function computeFirstInstallmentDueDate(selected_plan, custom_ledger, order) {
  const planObj = parsePlan(selected_plan);
  const totalMonths = planObj?.months || planObj?.duration || order?.months || 0;
  const monthlyAmt = planObj?.monthly_amount || planObj?.monthlyAmount || order?.monthly_amount || 0;
  const deliveryDate = now();

  if (!(totalMonths > 0 && monthlyAmt > 0)) return addMonths(deliveryDate, 1);

  const customLedger = parseCustomLedger(custom_ledger);
  if (Array.isArray(customLedger) && customLedger.length === totalMonths && customLedger[0]?.date) {
    return new Date(customLedger[0].date);
  }
  return addMonths(deliveryDate, 1);
}

/**
 * Determines PayTrigger brand + gate eligibility for a delivery request.
 * Pure/read-only — does not enroll anything.
 */
function resolvePaytriggerGate({ enrollPaytriggerFlag, product_imei, productNameSnapshot, inventoryCategory }) {
  const enrollPaytrigger = enrollPaytriggerFlag === true || enrollPaytriggerFlag === 'true';
  const paytriggerBrand = pt.detectBrand(productNameSnapshot);
  const eligible = Boolean(paytriggerBrand && pt.isEligible(paytriggerBrand, inventoryCategory));
  const gateRequired = Boolean(enrollPaytrigger && pt.ENABLED() && product_imei && eligible);
  return { enrollPaytrigger, paytriggerBrand, eligible, gateRequired };
}

// ─── Ledger + consumer numbers (shared between both modes) ────────────────

async function buildInstallmentLedgerAndConsumerNumbers({ order, delivery, payload, advanceAmount, planObj, purchaser, feedbackLabel }) {
  let installmentLedger = null;
  let ledgerUrl = null;

  try {
    const monthlyAmt = planObj?.monthly_amount || planObj?.monthlyAmount || order.monthly_amount || 0;
    const totalMonths = planObj?.months || planObj?.duration || order.months || 0;
    const deliveryDate = now();

    if (!(totalMonths > 0 && monthlyAmt > 0)) {
      return { installmentLedger: null, ledgerUrl: null };
    }

    let ledgerRows = [];
    const customLedger = parseCustomLedger(payload.custom_ledger);

    ledgerRows.push({
      month: 0,
      label: 'Advance Payment',
      due_date: deliveryDate,
      amount: parseFloat(advanceAmount || 0),
      status: 'paid',
      paid_at: deliveryDate,
      payment_method: 'Cash',
      feedback: feedbackLabel,
    });

    if (customLedger && Array.isArray(customLedger) && customLedger.length === totalMonths) {
      customLedger.forEach((row, i) => {
        ledgerRows.push({
          month: i + 1,
          label: `Month ${i + 1}`,
          due_date: row.date ? new Date(row.date) : addMonths(deliveryDate, i + 1),
          amount: parseFloat(row.amount) || parseFloat(monthlyAmt),
          status: 'pending',
          paid_at: null,
        });
      });
    } else {
      for (let i = 0; i < totalMonths; i++) {
        ledgerRows.push({
          month: i + 1,
          label: `Month ${i + 1}`,
          due_date: addMonths(deliveryDate, i + 1),
          amount: parseFloat(monthlyAmt),
          status: 'pending',
          paid_at: null,
        });
      }
    }

    const ledgerToken = jwt.sign(
      { order_id: order.id, delivery_id: delivery.id },
      LEDGER_TOKEN_SECRET,
      { expiresIn: '730d' }
    );

    const imeiStr = payload.product_imei ? String(payload.product_imei).replace(/\D/g, '') : '';
    const shortId = imeiStr.length >= 6 ? imeiStr.slice(-6) : crypto.randomBytes(4).toString('hex').slice(0, 6);
    ledgerUrl = `${shortId}`;

    installmentLedger = await prisma.installmentLedger.upsert({
      where: { order_id: order.id },
      create: {
        order_id: order.id,
        delivery_id: delivery.id,
        token: ledgerToken,
        short_id: shortId,
        ledger_rows: ledgerRows,
        created_at: now(),
        updated_at: now(),
      },
      update: {
        delivery_id: delivery.id,
        token: ledgerToken,
        short_id: shortId,
        ledger_rows: ledgerRows,
        updated_at: now(),
      },
    });

    const mobile = purchaser?.telephone_number || order.whatsapp_number;
    const consumerNo = await generateConsumerNumber(payload.product_imei, mobile);
    const smartPayConsumerNo = await generateSmartPayConsumerNumber(payload.product_imei, mobile);

    let firstMonthDue = 0;
    let dueDate = new Date();
    let billingMonthStr = '0000';

    if (Array.isArray(ledgerRows) && ledgerRows.length > 1) {
      firstMonthDue = ledgerRows[1].amount || 0;
      if (ledgerRows[1].due_date) {
        const d = new Date(ledgerRows[1].due_date);
        if (!isNaN(d.getTime())) {
          dueDate = d;
          billingMonthStr = String(d.getFullYear()).slice(-2) + String(d.getMonth() + 1).padStart(2, '0');
        }
      }
    }

    const customerName = purchaser?.name || order.customer_name || 'N/A';

    try {
      await prisma.consumerNumber.createMany({
        data: [
          {
            consumer_number: consumerNo,
            ledger_id: installmentLedger.id,
            delivery_id: delivery.id,
            customer_name: customerName,
            mobile_number: mobile || 'N/A',
            imei_serial: payload.product_imei || null,
            amount_due: firstMonthDue,
            billing_month: billingMonthStr,
            due_date: dueDate,
            bill_status: 'U',
            created_at: now(),
            updated_at: now(),
          },
          {
            consumer_number: smartPayConsumerNo,
            ledger_id: installmentLedger.id,
            delivery_id: delivery.id,
            customer_name: customerName,
            mobile_number: mobile || 'N/A',
            imei_serial: payload.product_imei || null,
            amount_due: firstMonthDue,
            billing_month: billingMonthStr,
            due_date: dueDate,
            bill_status: 'U',
            created_at: now(),
            updated_at: now(),
          },
        ],
      });
    } catch (consumerErr) {
      console.error('[deliveryCompletionService] Failed to create ConsumerNumbers (Non-fatal):', consumerErr);
    }
  } catch (ledgerErr) {
    console.error('[deliveryCompletionService] Ledger creation error:', ledgerErr);
  }

  return { installmentLedger, ledgerUrl };
}

function sendCompletionWatiMessages({ purchaser, order, productNameSnapshot, colorVariant, advanceAmount, orderStatusLabel, installmentLedger, ledgerUrl, product_imei, confirmedCustomerName, deliveredByName, deliveredByNumber }) {
  const customerPhone = purchaser?.telephone_number;
  const deliveryDateStr = formatDatePK(now());

  if (!customerPhone) {
    console.warn('[deliveryCompletionService] No customer phone — WATI messages skipped for order', order.order_ref);
    return;
  }

  // Installment summary for the delivery-confirmation message — same normalized
  // ledger math used everywhere else (getNormalizedLedger), so these figures stay
  // consistent with the customer's ledger page.
  let totalInstallmentPrice = 0;
  let installmentDuration = 0;
  let monthlyInstallment = 0;
  let nextDueDateStr = 'N/A';
  let remainingAmountVal = 0;
  if (installmentLedger?.ledger_rows) {
    const normalized = getNormalizedLedger(installmentLedger.ledger_rows);
    installmentDuration = normalized.installment_ledger.length;
    monthlyInstallment = normalized.installment_ledger[0]?.dueAmount || 0;
    totalInstallmentPrice = normalized.summary.grandTotalDue;
    remainingAmountVal = normalized.summary.grandTotalRemaining;
    const nextRow = normalized.installment_ledger.find(r => r.status !== 'paid');
    nextDueDateStr = nextRow ? formatDatePK(nextRow.dueDate) : 'N/A';
  }

  sendDeliveryConfirmation(customerPhone, {
    customerName: confirmedCustomerName,
    productName: productNameSnapshot,
    imei: product_imei || 'N/A',
    advanceAmount,
    deliveryDate: deliveryDateStr,
    orderRef: order.order_ref,
    orderStatus: orderStatusLabel,
    deliveredByName: deliveredByName || 'N/A',
    deliveredByNumber: deliveredByNumber || 'N/A',
    branchName: order.outlet?.name || 'N/A',
    branchCode: order.outlet?.code || 'N/A',
    totalInstallmentPrice,
    installmentDuration,
    monthlyInstallment,
    nextDueDate: nextDueDateStr,
    remainingAmount: remainingAmountVal,
    ledgerUrl,
  }).then(r => console.log('[WATI] Delivery confirmation:', r?.success ? 'sent ✓' : r?.error))
    .catch(e => console.error('[WATI] Delivery confirmation error:', e));

  sendAccountAwarenessForOrder(order.id, customerPhone, { itemName: productNameSnapshot });

  const sendLedgerTo = (phone) => {
    if (!installmentLedger || !ledgerUrl) return;
    sendCustomerLedger(phone, {
      customerName: confirmedCustomerName,
      orderRef: order.order_ref,
      itemName: productNameSnapshot,
      remainingBalance: remainingAmountVal,
      ledgerUrl,
    }).catch(e => console.error('[WATI] Ledger template error:', e));
  };

  sendLedgerTo(customerPhone);
  const altPhone = purchaser?.alternate_phone_number;
  if (altPhone) sendLedgerTo(altPhone);
}

// ─── Agent (Delivery Officer) completion ───────────────────────────────────

async function completeAgentDelivery({ order, payload, io, productNameSnapshot, inventoryCategory, existingDeliveryId = null }) {
  const user = payload.user;
  const purchaser = order.verification?.purchaser;
  const confirmedCustomerName = purchaser?.name || purchaser?.full_name || order.customer_name;

  let delivery;
  if (existingDeliveryId) {
    delivery = await prisma.delivery.update({
      where: { id: existingDeliveryId },
      data: {
        status: 'completed',
        end_time: now(),
        verified: true,
        updated_at: now(),
      },
    });
  } else {
    delivery = await prisma.delivery.create({
      data: {
        order_id: order.id,
        delivery_agent_id: user.id,
        status: 'completed',
        start_time: now(),
        end_time: now(),
        verified: true,
        product_imei: payload.product_imei || null,
        selected_plan: payload.selected_plan || null,
        feedback: payload.feedback || null,
        created_at: now(),
        updated_at: now(),
      },
    });
  }

  let colorVariant = null;
  let stockTransferId = null;

  if (payload.product_imei) {
    const inventory = await prisma.outletInventory.findFirst({ where: { imei_serial: payload.product_imei } });
    if (inventory) {
      await prisma.outletInventory.update({
        where: { id: inventory.id },
        data: { status: 'Sold', updated_at: now() },
      });

      inventoryCategory = inventoryCategory || inventory.category;
      colorVariant = inventory.color_variant || null;
      productNameSnapshot = productNameSnapshot || inventory.product_name;

      const transfer = await prisma.stockTransfer.findFirst({
        where: {
          inventory_id: inventory.id,
          to_id: user.id,
          to_type: 'Delivery Officer',
          status: 'transferred',
        },
      });

      if (transfer) {
        stockTransferId = transfer.id;
        await prisma.stockTransfer.update({
          where: { id: transfer.id },
          data: { status: 'delivered', updated_at: now() },
        });
      }
    }
  }

  const uploadsData = [];
  const u = payload.uploads || {};
  (u.facePhotos || []).forEach((f) => uploadsData.push({ delivery_id: delivery.id, upload_type: 'face_photo', file_url: f.url, tag: f.tag || null, uploaded_at: now() }));
  (u.locationPhotos || []).forEach((f) => uploadsData.push({ delivery_id: delivery.id, upload_type: 'location_photo', file_url: f.url, tag: f.tag || null, uploaded_at: now() }));
  (u.housePhotos || []).forEach((f) => uploadsData.push({ delivery_id: delivery.id, upload_type: 'house_photo', file_url: f.url, tag: f.tag || null, uploaded_at: now() }));
  (u.locationLinks || []).forEach((l) => uploadsData.push({ delivery_id: delivery.id, upload_type: 'location_link', link: l.link, tag: l.tag || null, uploaded_at: now() }));
  if (uploadsData.length > 0) {
    await prisma.deliveryUpload.createMany({ data: uploadsData });
  }

  await prisma.order.update({
    where: { id: order.id },
    data: {
      status: 'delivered',
      is_delivered: true,
      delivered_at: order.delivered_at || now(),
      updated_at: now(),
    },
  });

  await logOrderStatusChange(order.id, order.status, 'delivered', user);

  let advanceAmount = 0.0;
  const planObj = parsePlan(payload.selected_plan);
  if (planObj && (planObj.advance !== undefined || planObj.advance_amount !== undefined)) {
    advanceAmount = parseFloat(planObj.advance || planObj.advance_amount);
  }

  if (advanceAmount > 0) {
    await prisma.cashInHand.create({
      data: {
        officer_id: user.id,
        order_id: order.id,
        amount: advanceAmount,
        status: 'pending',
        customer_name: confirmedCustomerName,
        product_name: productNameSnapshot,
        imei_serial: payload.product_imei || null,
        color_variant: colorVariant || null,
        stock_transfer_id: stockTransferId,
        payment_method: 'Cash',
        created_at: now(),
        updated_at: now(),
      },
    });

    await createOfficerTransaction({
      officer_id: user.id,
      type: 'credit',
      amount: advanceAmount,
      status: 'pending',
      description: `Advance payment collected from ${confirmedCustomerName}`,
      payment_method: 'Cash',
      order_ref: order.order_ref,
    });
  }

  const { installmentLedger, ledgerUrl } = await buildInstallmentLedgerAndConsumerNumbers({
    order, delivery, payload, advanceAmount, planObj, purchaser,
    feedbackLabel: 'Collected at Delivery',
  });

  sendCompletionWatiMessages({
    purchaser, order, productNameSnapshot, colorVariant, advanceAmount,
    orderStatusLabel: 'Delivered', installmentLedger, ledgerUrl,
    product_imei: payload.product_imei, confirmedCustomerName,
    deliveredByName: user.full_name, deliveredByNumber: user.phone,
  });

  const updatedDelivery = await prisma.delivery.findUnique({
    where: { id: delivery.id },
    include: {
      delivery_agent: { select: { full_name: true, username: true } },
      uploads: true,
      order: { select: { order_ref: true } },
    },
  });

  await notifyAdmins(
    'Delivery Submitted',
    `Delivery completed for Order #${updatedDelivery.order.order_ref} by ${updatedDelivery.delivery_agent.full_name}`,
    'delivery_complete',
    updatedDelivery.id,
    io
  );

  if (order.outlet_id) {
    await notifyOutlet(
      order.outlet_id,
      'Delivery Completed',
      `Delivery has been successfully completed for Order #${updatedDelivery.order.order_ref}.`,
      'delivery_complete',
      updatedDelivery.id,
      io
    );
  }

  io?.to(`officer_${user.id}`).emit('delivery_data_updated', { reason: 'delivery_submitted', orderId: order.id });

  return { delivery: updatedDelivery, ledgerUrl };
}

// ─── Self Pickup (Outlet/Branch) completion ────────────────────────────────

async function completeSelfPickupDelivery({ order, payload, io, productNameSnapshot, inventoryCategory, existingDeliveryId = null }) {
  const user = payload.user;
  const outlet_id = payload.outlet_id;
  const purchaser = order.verification?.purchaser;
  const confirmedCustomerName = purchaser?.name || purchaser?.full_name || order.customer_name;

  let advanceAmount = 0.0;
  const planObj = parsePlan(payload.selected_plan);
  if (planObj && (planObj.advance !== undefined || planObj.advance_amount !== undefined)) {
    advanceAmount = parseFloat(planObj.advance || planObj.advance_amount);
  }

  const result = await prisma.$transaction(async (tx) => {
    let colorVariant = null;
    let localProductNameSnapshot = productNameSnapshot || order.product_name;

    if (payload.product_imei) {
      const inventory = await tx.outletInventory.findFirst({ where: { imei_serial: payload.product_imei, outlet_id } });
      if (inventory) {
        await tx.outletInventory.update({
          where: { id: inventory.id },
          data: { status: 'Sold', updated_at: now() },
        });
        inventoryCategory = inventoryCategory || inventory.category;
        colorVariant = inventory.color_variant || null;
        localProductNameSnapshot = inventory.product_name;

        await tx.stockTransfer.create({
          data: {
            inventory_id: inventory.id,
            from_type: 'Outlet',
            from_id: outlet_id,
            to_type: 'Customer',
            to_id: order.id,
            status: 'completed',
            quantity_transferred: 1,
            created_at: now(),
            updated_at: now(),
          },
        });
      }
    }

    let delivery;
    if (existingDeliveryId) {
      delivery = await tx.delivery.update({
        where: { id: existingDeliveryId },
        data: {
          status: 'completed',
          end_time: now(),
          verified: true,
          updated_at: now(),
        },
      });
    } else {
      delivery = await tx.delivery.create({
        data: {
          order_id: order.id,
          delivery_agent_id: user.id,
          status: 'completed',
          start_time: now(),
          end_time: now(),
          verified: true,
          product_imei: payload.product_imei || null,
          selected_plan: payload.selected_plan || null,
          self_pickup: true,
          feedback: payload.feedback || null,
          created_at: now(),
          updated_at: now(),
        },
      });
    }

    const facePhotos = (payload.uploads && payload.uploads.facePhotos) || [];
    if (facePhotos.length > 0) {
      await tx.deliveryUpload.createMany({
        data: facePhotos.map((f) => ({
          delivery_id: delivery.id,
          upload_type: 'face_photo',
          file_url: f.url,
          uploaded_at: now(),
        })),
      });
    }

    await tx.order.update({
      where: { id: order.id },
      data: {
        status: 'delivered',
        is_delivered: true,
        delivered_at: order.delivered_at || now(),
        updated_at: now(),
      },
    });

    if (advanceAmount > 0) {
      await tx.cashInHand.create({
        data: {
          officer_id: user.id,
          outlet_id,
          order_id: order.id,
          amount: advanceAmount,
          submitted_amount: advanceAmount,
          status: 'paid',
          customer_name: confirmedCustomerName,
          product_name: localProductNameSnapshot,
          imei_serial: payload.product_imei || null,
          color_variant: colorVariant || null,
          payment_method: 'Cash',
          cash_type: 'Down payment (Self Pickup)',
          created_at: now(),
          updated_at: now(),
        },
      });

      await updateCashRegister(tx, outlet_id, 'down_payments', advanceAmount, 'add');
    }

    return { delivery, productNameSnapshot: localProductNameSnapshot, colorVariant };
  }, { maxWait: 5000, timeout: 20000 });

  const { delivery, colorVariant } = result;
  productNameSnapshot = result.productNameSnapshot;

  await logOrderStatusChange(order.id, order.status, 'delivered', user);

  const { installmentLedger, ledgerUrl } = await buildInstallmentLedgerAndConsumerNumbers({
    order, delivery, payload, advanceAmount, planObj, purchaser,
    feedbackLabel: 'Self Pickup at Branch',
  });

  sendCompletionWatiMessages({
    purchaser, order, productNameSnapshot, colorVariant, advanceAmount,
    orderStatusLabel: 'Delivered (Self Pickup)', installmentLedger, ledgerUrl,
    product_imei: payload.product_imei, confirmedCustomerName,
    deliveredByName: user.full_name, deliveredByNumber: user.phone,
  });

  await notifyAdmins(
    'Self Pickup Completed',
    `Order #${order.order_ref} picked up at Branch (Outlet ID: ${outlet_id}) by ${user.full_name}`,
    'delivery_complete',
    delivery.id,
    io
  );

  await notifyOutlet(
    outlet_id,
    'Self Pickup Completed',
    `Order #${order.order_ref} has been picked up by the customer at your branch.`,
    'delivery_complete',
    delivery.id,
    io
  );

  return { delivery, ledgerUrl };
}

// ─── PayTrigger gate: initiate + complete ─────────────────────────────────

/**
 * Called from submitDelivery / submitSelfPickupDelivery when PayTrigger enrollment
 * is requested and the device is eligible. Creates a *pending* Delivery placeholder
 * (status = awaiting_paytrigger_enrollment) instead of completing the delivery, and
 * kicks off PayTrigger pre-enrollment. The placeholder row doubles as the existing
 * "delivery already submitted" duplicate-protection guard (order.delivery is now set).
 *
 * No final records (ledger, cash-in-hand, consumer numbers, uploads, WATI "Delivered"
 * messages) are created here — those only happen in completeAgentDelivery/
 * completeSelfPickupDelivery, invoked later by completePendingPaytriggerDelivery.
 */
async function initiateGatedDelivery({ mode, order, payload, io, productNameSnapshot, inventoryCategory }) {
  const firstInstallmentDueDate = computeFirstInstallmentDueDate(payload.selected_plan, payload.custom_ledger, order);

  const delivery = await prisma.delivery.create({
    data: {
      order_id: order.id,
      delivery_agent_id: payload.user.id,
      status: PENDING_STATUS,
      start_time: now(),
      verified: false,
      product_imei: payload.product_imei || null,
      selected_plan: payload.selected_plan || null,
      feedback: payload.feedback || null,
      self_pickup: mode === 'self_pickup',
      pending_payload: { ...payload, mode, productNameSnapshot, inventoryCategory, firstInstallmentDueDate },
      created_at: now(),
      updated_at: now(),
    },
  });

  try {
    const licRes = await pt.checkLicense().catch(() => null);
    const licData = licRes?.data || licRes || {};
    const total = parseInt(licData?.totalAmountOfLicense ?? licData?.totalNum ?? licData?.totalCount ?? 0) || 0;
    const used = parseInt(licData?.amountUsedOfLicense ?? licData?.usedNum ?? licData?.usedCount ?? 0) || 0;
    const unused = parseInt(licData?.remainingAmountOfLicense ?? licData?.unusedNum ?? licData?.availableNum ?? licData?.availableCount ?? (total - used));
    if (!isNaN(unused) && unused <= 0) {
      const err = new Error('Licence Exceed. PayTrigger available licenses count is 0. Cannot enroll device until licenses are added.');
      err.paytriggerFailure = true;
      throw err;
    }
  } catch (licErr) {
    if (licErr.paytriggerFailure) throw licErr;
  }

  let enrollResult;
  try {
    enrollResult = await pt.preEnrollImei(payload.product_imei, order.order_ref, productNameSnapshot, firstInstallmentDueDate);
  } catch (e) {
    await prisma.delivery.delete({ where: { id: delivery.id } }).catch(() => {});
    const err = new Error(`PayTrigger pre-enrollment failed: ${e.message}`);
    err.paytriggerFailure = true;
    throw err;
  }

  if (!enrollResult || !(enrollResult.code === 200 || enrollResult.code === 50015)) {
    await prisma.delivery.delete({ where: { id: delivery.id } }).catch(() => {});
    const err = new Error(`PayTrigger enrollment rejected: ${enrollResult?.message || 'unknown error'}`);
    err.paytriggerFailure = true;
    err.paytriggerResult = enrollResult;
    throw err;
  }

  let deviceTag = null;
  let serverState = 500;
  let enrollmentStatus = 'pre_enrolled';

  if (enrollResult.code === 50015) {
    try {
      const dRes = await pt.getDeviceTag(payload.product_imei);
      if (dRes?.code === 200 && dRes.data) {
        deviceTag = dRes.data.deviceTag || null;
        serverState = dRes.data.serverState || 500;
        const stateMap = { 500: 'pre_enrolled', 1000: 'registered', 2000: 'ready_to_activate', 3000: 'active', 4000: 'locked', 5000: 'removable' };
        enrollmentStatus = stateMap[serverState] || 'pre_enrolled';
      }
    } catch (err) {
      console.error('[PayTrigger] Failed to recover device tag:', err.message);
    }
  }

  const device = await prisma.payTriggerDevice.upsert({
    where: { imei: payload.product_imei },
    update: {
      order_id: order.id,
      order_ref: order.order_ref,
      delivery_id: delivery.id,
      product_model: productNameSnapshot,
      device_tag: deviceTag,
      server_state: serverState,
      enrollment_status: enrollmentStatus,
      expiration: firstInstallmentDueDate,
      last_sync_at: now(),
      raw_state: enrollResult,
    },
    create: {
      imei: payload.product_imei,
      order_id: order.id,
      order_ref: order.order_ref,
      delivery_id: delivery.id,
      product_model: productNameSnapshot,
      device_tag: deviceTag,
      enrollment_status: enrollmentStatus,
      server_state: serverState,
      expiration: firstInstallmentDueDate,
      last_sync_at: now(),
      raw_state: enrollResult,
    },
  });

  // Rare edge case: device already reports ACTIVE at pre-enroll time (e.g. re-enrolling a
  // previously-activated device). No later webhook may ever arrive, so complete right away.
  if (enrollmentStatus === 'active') {
    const completion = await completePendingPaytriggerDelivery(device, io);
    if (completion?.completed) {
      return { delivery: completion.delivery, paytriggerDevice: device, completedImmediately: true };
    }
  }

  await prisma.order.update({
    where: { id: order.id },
    data: { status: PENDING_STATUS, updated_at: now() },
  });

  const notifyRoom = mode === 'self_pickup' ? `outlet_${payload.outlet_id}` : `officer_${payload.user.id}`;
  io?.to(`user_${payload.user.id}`).emit('notification', {
    type: 'info', title: 'PayTrigger', message: 'Delivery initiated. Waiting for device enrollment confirmation.',
  });
  io?.to(notifyRoom).emit('delivery_data_updated', {
    reason: 'paytrigger_enrollment_pending', orderId: order.id, delivery_id: delivery.id, status: PENDING_STATUS,
  });

  return { delivery, paytriggerDevice: device, completedImmediately: false };
}

/**
 * Idempotent webhook-triggered completion. Safe to call multiple times for the same
 * device/delivery — only the call that wins the atomic status transition proceeds.
 */
async function completePendingPaytriggerDelivery(device, io) {
  if (!device?.delivery_id) return { skipped: true, reason: 'no_delivery_linked' };

  const guard = await prisma.delivery.updateMany({
    where: { id: device.delivery_id, status: PENDING_STATUS },
    data: { status: COMPLETING_STATUS, updated_at: now() },
  });
  if (guard.count === 0) return { skipped: true, reason: 'already_processed_or_not_pending' };

  const delivery = await prisma.delivery.findUnique({ where: { id: device.delivery_id } });
  const payload = delivery?.pending_payload;

  if (!delivery || !payload) {
    if (delivery) {
      await prisma.delivery.update({ where: { id: delivery.id }, data: { status: PENDING_STATUS } }).catch(() => {});
    }
    return { skipped: true, reason: 'missing_pending_payload' };
  }

  const order = await prisma.order.findUnique({
    where: { id: delivery.order_id },
    include: { delivery: true, verification: { include: { purchaser: true } }, outlet: true },
  });

  if (!order) {
    await prisma.delivery.update({ where: { id: delivery.id }, data: { status: PENDING_STATUS } }).catch(() => {});
    return { skipped: true, reason: 'order_not_found' };
  }

  try {
    let out;
    if (payload.mode === 'self_pickup') {
      out = await completeSelfPickupDelivery({
        order, payload, io,
        productNameSnapshot: payload.productNameSnapshot,
        inventoryCategory: payload.inventoryCategory,
        existingDeliveryId: delivery.id,
      });
    } else {
      out = await completeAgentDelivery({
        order, payload, io,
        productNameSnapshot: payload.productNameSnapshot,
        inventoryCategory: payload.inventoryCategory,
        existingDeliveryId: delivery.id,
      });
    }

    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { pending_payload: null },
    }).catch(() => {});

    const room = payload.mode === 'self_pickup' ? `outlet_${payload.outlet_id}` : `officer_${payload.user.id}`;
    io?.to(room).emit('delivery_data_updated', {
      reason: 'paytrigger_delivery_completed', orderId: order.id, delivery_id: delivery.id, status: 'delivered',
    });
    io?.to(`user_${payload.user.id}`).emit('notification', {
      type: 'success', title: 'PayTrigger', message: 'Device enrolled and delivery completed successfully.',
    });

    return { completed: true, delivery: out.delivery, ledgerUrl: out.ledgerUrl };
  } catch (err) {
    console.error('[PayTrigger] completePendingPaytriggerDelivery failed:', err);
    await prisma.delivery.update({ where: { id: delivery.id }, data: { status: PENDING_STATUS } }).catch(() => {});

    const room = payload.mode === 'self_pickup' ? `outlet_${payload.outlet_id}` : `officer_${payload.user.id}`;
    io?.to(room).emit('delivery_data_updated', {
      reason: 'paytrigger_delivery_completion_failed', orderId: order.id, delivery_id: delivery.id, status: PENDING_STATUS,
    });
    io?.to(`user_${payload.user.id}`).emit('notification', {
      type: 'error', title: 'PayTrigger', message: 'Device enrolled, but completing the delivery failed. It will be retried.',
    });

    throw err;
  }
}

module.exports = {
  PENDING_STATUS,
  COMPLETING_STATUS,
  resolvePaytriggerGate,
  computeFirstInstallmentDueDate,
  completeAgentDelivery,
  completeSelfPickupDelivery,
  initiateGatedDelivery,
  completePendingPaytriggerDelivery,
};
