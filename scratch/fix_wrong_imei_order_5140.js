const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const { generateConsumerNumber, generateSmartPayConsumerNumber } = require('../src/utils/consumerNumberUtils');
const prisma = new PrismaClient();

// Order 5140 (Anees) was wrongly recorded as having received the Realme C100i
// (IMEI 862149080139258) that actually belongs to order 5237 (Shahzaib, whose
// records for that IMEI are correct and untouched). Anees actually received a
// Realme C71 6/128 (IMEI 860695075268538, inventory id 1302), matching order
// 5140's own originally-booked 12-month plan (advance 6900 / monthly 5100 /
// total 68100). This script:
//   - removes the wrong ConsumerNumber/InstallmentLedger/CashInHand/StockTransfer
//     rows created against the C100i for order 5140
//   - marks the real C71 unit (1302) Sold and creates the correct StockTransfer
//   - updates Delivery 769 + Order 5140 to point at the real IMEI/plan
//   - rebuilds the installment ledger + consumer numbers using the app's own
//     generation utilities, preserving the existing 20th-of-month billing cycle
// It does NOT touch order 5237 / inventory 1299 — those are correct as-is.

const ORDER_ID = 5140;
const DELIVERY_ID = 769;
const WRONG_IMEI = '862149080139258';
const WRONG_INVENTORY_ID = 1299;
const CORRECT_IMEI = '860695075268538';
const CORRECT_INVENTORY_ID = 1302;
const WRONG_STOCK_TRANSFER_ID = 1119;
const WRONG_CASH_IN_HAND_ID = 800;

const CORRECT_PLAN = { advance: 6900, totalPrice: 68100, monthlyAmount: 5100, months: 12, isActive: true };

async function main() {
  const order = await prisma.order.findUnique({
    where: { id: ORDER_ID },
    include: { verification: { include: { purchaser: true } } },
  });
  const delivery = await prisma.delivery.findUnique({ where: { id: DELIVERY_ID } });
  const wrongInventory = await prisma.outletInventory.findUnique({ where: { id: WRONG_INVENTORY_ID } });
  const correctInventory = await prisma.outletInventory.findUnique({ where: { id: CORRECT_INVENTORY_ID } });

  if (!order || order.id !== ORDER_ID) throw new Error('Order 5140 not found — aborting.');
  if (!delivery || delivery.order_id !== ORDER_ID) throw new Error('Delivery 769 not found or mismatched — aborting.');
  if (delivery.product_imei !== WRONG_IMEI) throw new Error(`Delivery.product_imei is "${delivery.product_imei}", expected the wrong C100i IMEI — already fixed? Aborting.`);
  if (!correctInventory || correctInventory.status !== 'In Stock') throw new Error(`Correct C71 inventory (1302) status is "${correctInventory?.status}", expected "In Stock" — aborting.`);
  if (!wrongInventory) throw new Error('C100i inventory (1299) not found — aborting.');

  console.log('Pre-flight checks passed. Proceeding with correction...\n');

  const originalDeliveryDate = delivery.created_at; // 2026-07-28T18:46:59.772Z — preserve real event time

  // 1. Remove the wrong records tied to order 5140 (does NOT touch order 5237's data)
  const deletedConsumers = await prisma.consumerNumber.deleteMany({ where: { delivery_id: DELIVERY_ID } });
  console.log('Deleted wrong ConsumerNumbers:', deletedConsumers.count);

  const deletedLedger = await prisma.installmentLedger.deleteMany({ where: { order_id: ORDER_ID } });
  console.log('Deleted wrong InstallmentLedger:', deletedLedger.count);

  const deletedCash = await prisma.cashInHand.deleteMany({ where: { id: WRONG_CASH_IN_HAND_ID, order_id: ORDER_ID } });
  console.log('Deleted wrong CashInHand:', deletedCash.count);

  const deletedTransfer = await prisma.stockTransfer.deleteMany({ where: { id: WRONG_STOCK_TRANSFER_ID, to_id: ORDER_ID } });
  console.log('Deleted wrong StockTransfer:', deletedTransfer.count);

  // 2. Mark the real C71 unit Sold and record the correct stock movement
  await prisma.outletInventory.update({
    where: { id: CORRECT_INVENTORY_ID },
    data: { status: 'Sold', updated_at: new Date() },
  });
  const newTransfer = await prisma.stockTransfer.create({
    data: {
      from_type: 'Outlet',
      from_id: order.outlet_id,
      to_type: 'Customer',
      to_id: ORDER_ID,
      inventory_id: CORRECT_INVENTORY_ID,
      status: 'completed',
      quantity_transferred: 1,
      created_at: originalDeliveryDate,
      updated_at: originalDeliveryDate,
    },
  });
  console.log('Created correct StockTransfer:', newTransfer.id);

  // 3. Point Delivery + Order at the real IMEI/plan
  await prisma.delivery.update({
    where: { id: DELIVERY_ID },
    data: {
      product_imei: CORRECT_IMEI,
      selected_plan: JSON.stringify(CORRECT_PLAN),
      updated_at: new Date(),
    },
  });
  await prisma.order.update({
    where: { id: ORDER_ID },
    data: { imei_serial: CORRECT_IMEI, updated_at: new Date() },
  });
  console.log('Updated Delivery + Order with correct IMEI/plan.');

  // 4. Correct CashInHand entry
  const newCash = await prisma.cashInHand.create({
    data: {
      officer_id: 75,
      outlet_id: order.outlet_id,
      order_id: ORDER_ID,
      amount: CORRECT_PLAN.advance,
      submitted_amount: CORRECT_PLAN.advance,
      status: 'paid',
      customer_name: 'M.Anees',
      product_name: correctInventory.product_name,
      imei_serial: CORRECT_IMEI,
      cash_type: 'Down payment (Self Pickup)',
      payment_method: 'Cash',
      created_at: originalDeliveryDate,
      updated_at: originalDeliveryDate,
    },
  });
  console.log('Created correct CashInHand:', newCash.id);

  // 5. Rebuild ledger with correct amounts, preserving the existing 20th-of-month cycle
  const deliveryDate = new Date(originalDeliveryDate);
  const baseYear = deliveryDate.getUTCFullYear();
  const baseMonth = deliveryDate.getUTCMonth(); // 0-indexed; July = 6

  const ledgerRows = [{
    month: 0,
    label: 'Advance Payment',
    due_date: deliveryDate,
    amount: CORRECT_PLAN.advance,
    status: 'paid',
    paid_at: deliveryDate,
    payment_method: 'Cash',
    feedback: 'Self Pickup at Branch',
  }];
  for (let i = 1; i <= CORRECT_PLAN.months; i++) {
    const dueDate = new Date(Date.UTC(baseYear, baseMonth + i, 20));
    ledgerRows.push({
      month: i,
      label: `Month ${i}`,
      due_date: dueDate,
      amount: CORRECT_PLAN.monthlyAmount,
      status: 'pending',
      paid_at: null,
    });
  }

  const ledgerToken = jwt.sign(
    { order_id: ORDER_ID, delivery_id: DELIVERY_ID },
    process.env.LEDGER_TOKEN_SECRET,
    { expiresIn: '730d' }
  );
  const shortId = CORRECT_IMEI.slice(-6);

  const newLedger = await prisma.installmentLedger.create({
    data: {
      order_id: ORDER_ID,
      delivery_id: DELIVERY_ID,
      token: ledgerToken,
      short_id: shortId,
      ledger_rows: ledgerRows,
      created_at: originalDeliveryDate,
      updated_at: new Date(),
    },
  });
  console.log('Created correct InstallmentLedger:', newLedger.id);

  const mobile = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
  const consumerNo = await generateConsumerNumber(CORRECT_IMEI, mobile);
  const smartPayConsumerNo = await generateSmartPayConsumerNumber(CORRECT_IMEI, mobile);
  const firstMonthDue = ledgerRows[1].amount;
  const firstDueDate = ledgerRows[1].due_date;
  const billingMonthStr = String(firstDueDate.getFullYear()).slice(-2) + String(firstDueDate.getMonth() + 1).padStart(2, '0');

  await prisma.consumerNumber.createMany({
    data: [
      {
        consumer_number: consumerNo,
        ledger_id: newLedger.id,
        delivery_id: DELIVERY_ID,
        customer_name: 'M.Anees',
        mobile_number: mobile || 'N/A',
        imei_serial: CORRECT_IMEI,
        amount_due: firstMonthDue,
        billing_month: billingMonthStr,
        due_date: firstDueDate,
        bill_status: 'U',
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        consumer_number: smartPayConsumerNo,
        ledger_id: newLedger.id,
        delivery_id: DELIVERY_ID,
        customer_name: 'M.Anees',
        mobile_number: mobile || 'N/A',
        imei_serial: CORRECT_IMEI,
        amount_due: firstMonthDue,
        billing_month: billingMonthStr,
        due_date: firstDueDate,
        bill_status: 'U',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ],
  });
  console.log('Created correct ConsumerNumbers:', consumerNo, smartPayConsumerNo);

  console.log('\nDONE. Order 5140 now correctly reflects Realme C71 (IMEI 860695075268538). Order 5237 (Shahzaib) was not touched.');
}

main().catch((e) => console.error('\nFAILED (no partial state assumed safe — check output above for what already ran):', e)).finally(() => prisma.$disconnect());
