const prisma = require('../../lib/prisma');
const pt = require('../services/paytriggerService');

const now = () => new Date();

/**
 * Call after an installment row has just been paid in full. Pushes the
 * PayTrigger device's lock expiration to the next unpaid installment's due
 * date, or removes the lock entirely if that was the last unpaid installment
 * (loan finished). Non-blocking: any failure is logged, never thrown, so a
 * PayTrigger outage can't block payment recording.
 *
 * @param {object} params
 * @param {string} params.imeiSerial
 * @param {object} params.order - order.order_ref must be set
 * @param {Array} params.rows - full normalized ledger rows (post-payment update)
 * @param {number} params.rowIndex - index of the row that was just paid
 * @param {number|string} params.month_number
 * @param {string} [params.phone]
 */
async function syncPayTriggerAfterPayment({ imeiSerial, order, rows, rowIndex, month_number, phone }) {
  if (!pt.ENABLED() || !imeiSerial) return;

  try {
    const device = await prisma.payTriggerDevice.findFirst({ where: { imei: imeiSerial } });
    if (!device) return;

    const installmentRows = rows.filter(r => r.month > 0);
    const nextUnpaidRow = installmentRows.find(r => r.status !== 'paid');
    const advanceRow = rows.find(r => r.month === 0);
    const cumulativePaid = installmentRows.reduce((s, r) => s + parseFloat(r.paid_amount || 0), 0)
      + (advanceRow?.status === 'paid' ? parseFloat(advanceRow.amount || 0) : 0);
    const grandTotal = rows.reduce((s, r) => s + parseFloat(r.amount || r.dueAmount || 0), 0);

    if (nextUnpaidRow) {
      const nextDueDate = new Date(nextUnpaidRow.due_date || nextUnpaidRow.dueDate);
      const result = await pt.updateRepayInfo({
        imei: imeiSerial,
        deviceTag: device.device_tag || '',
        orderNum: order.order_ref,
        phoneNum: phone || '',
        repayedAmt: cumulativePaid,
        totalAmt: grandTotal,
        nextRepayTime: nextDueDate,
        nextRepayAmt: parseFloat(nextUnpaidRow.amount || nextUnpaidRow.dueAmount || 0),
        currentTerm: rows[rowIndex].month,
        totalTerm: installmentRows.length,
        description: `Installment month ${month_number} paid`,
      });
      console.log('[PayTrigger] updateRepayInfo ok:', result?.code, result?.message);
      if (result?.code === 200) {
        await prisma.payTriggerDevice.update({
          where: { imei: imeiSerial },
          data: { expiration: nextDueDate, last_sync_at: now(), raw_state: result },
        });
      }
    } else {
      const result = await pt.removeLock({ imei: imeiSerial, deviceTag: device.device_tag || '' });
      console.log('[PayTrigger] removeLock ok:', result?.code, result?.message);
      if (result?.code === 200) {
        await prisma.payTriggerDevice.update({
          where: { imei: imeiSerial },
          data: {
            lock_status: 'unlocked',
            server_state: 5000,
            enrollment_status: 'removable',
            last_sync_at: now(),
            raw_state: result,
          },
        });
      }
    }
  } catch (e) {
    console.error('[PayTrigger] repay/unlock sync failed:', e.message);
  }
}

module.exports = { syncPayTriggerAfterPayment };
