const prisma = require('../../lib/prisma');
const pt = require('../services/paytriggerService');
const { notifyAdmins } = require('./notificationUtils');

const now = () => new Date();

// Surfaces a sync failure to admins instead of letting it fail silently —
// this is exactly what let a paid installment's device stay locked for days
// with nobody noticing until the customer complained.
const alertSyncFailure = (order, message) => {
  console.error(`[PayTrigger] ${message}`);
  if (order?.id) {
    notifyAdmins(
      'PayTrigger: Device did not unlock',
      `Order #${order.order_ref || order.id} — ${message} Please check Admin > PayTrigger and unlock manually if needed.`,
      'paytrigger_sync_failed',
      order.id
    ).catch(() => {});
  }
};

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
  if (!pt.ENABLED()) return;

  if (!imeiSerial) {
    alertSyncFailure(order, 'installment paid but no IMEI is recorded on this order, so the device lock could not be synced.');
    return;
  }

  try {
    const device = await prisma.payTriggerDevice.findFirst({ where: { imei: imeiSerial } });
    if (!device) {
      alertSyncFailure(order, `installment paid but no PayTrigger device is enrolled for IMEI ${imeiSerial} — the device will NOT auto-unlock.`);
      return;
    }

    // Filter installment rows (month > 0)
    const installmentRows = rows.filter(r => r.month > 0);
    
    // Find next unpaid installment row (case-insensitive check on status + positive remaining balance)
    const nextUnpaidRow = installmentRows.find(r => {
      const status = (r.status || '').toLowerCase();
      const amount = parseFloat(r.amount || r.dueAmount || 0);
      const paid = parseFloat(r.paid_amount || r.paidAmount || 0);
      return status !== 'paid' && (amount - paid) > 0.01;
    });

    const advanceRow = rows.find(r => r.month === 0);
    const cumulativePaid = installmentRows.reduce((s, r) => s + parseFloat(r.paid_amount || r.paidAmount || 0), 0)
      + ((advanceRow?.status || '').toLowerCase() === 'paid' ? parseFloat(advanceRow.amount || 0) : 0);
    const grandTotal = rows.reduce((s, r) => s + parseFloat(r.amount || r.dueAmount || 0), 0);

    if (nextUnpaidRow) {
      const rawDateStr = nextUnpaidRow.due_date || nextUnpaidRow.dueDate;
      const nextDueDate = new Date(rawDateStr);
      // Set hours to 23:59:59.999 so device lock expiration does not occur at 00:00:00 UTC morning
      if (!isNaN(nextDueDate.getTime())) {
        nextDueDate.setHours(23, 59, 59, 999);
      }

      const currentTermVal = (rows && rowIndex !== undefined && rows[rowIndex] && rows[rowIndex].month) ? rows[rowIndex].month : 1;
      const orderRef = order?.order_ref || device.order_ref || '';

      const result = await pt.updateRepayInfo({
        imei: imeiSerial,
        deviceTag: device.device_tag || '',
        orderNum: orderRef,
        phoneNum: phone || '',
        repayedAmt: cumulativePaid,
        totalAmt: grandTotal,
        nextRepayTime: nextDueDate,
        nextRepayAmt: parseFloat(nextUnpaidRow.amount || nextUnpaidRow.dueAmount || 0),
        currentTerm: currentTermVal,
        totalTerm: installmentRows.length,
        description: `Installment month ${month_number || ''} paid`,
      });
      console.log('[PayTrigger] updateRepayInfo ok:', result?.code, result?.message);

      // CRITICAL: If device is currently locked, updateRepayInfo alone won't remove screen lock policy.
      // Call tempUnlock to issue cloud unlock command so the phone screen unlocks immediately!
      let unlockResult = null;
      const wasLocked = device.lock_status === 'locked' || device.mobile_status === 1000;
      if (wasLocked) {
        console.log(`[PayTrigger] Device ${imeiSerial} is locked. Triggering tempUnlock to release screen lock...`);
        unlockResult = await pt.tempUnlock({ imei: imeiSerial, deviceTag: device.device_tag || '' });
        console.log('[PayTrigger] tempUnlock on payment ok:', unlockResult?.code, unlockResult?.message);
      }

      // Only mark the device unlocked in our DB once PayTrigger actually confirms
      // it (code 200) — previously this wrote lock_status:'unlocked' unconditionally,
      // so a rejected/failed API call (bad deviceTag, expired session, etc.) still
      // showed as unlocked on our dashboard while the phone stayed locked for real.
      const repayOk = result?.code === 200;
      const unlockOk = !wasLocked || unlockResult?.code === 200;
      if (!repayOk || !unlockOk) {
        await prisma.payTriggerDevice.update({
          where: { imei: imeiSerial },
          data: { last_sync_at: now(), raw_state: unlockResult || result || {} },
        });
        alertSyncFailure(order, `payment recorded but PayTrigger did not confirm the unlock for IMEI ${imeiSerial} (updateRepayInfo: ${result?.code}/${result?.message}${wasLocked ? `, tempUnlock: ${unlockResult?.code}/${unlockResult?.message}` : ''}).`);
        return;
      }

      await prisma.payTriggerDevice.update({
        where: { imei: imeiSerial },
        data: {
          expiration: nextDueDate,
          lock_status: 'unlocked',
          last_sync_at: now(),
          raw_state: unlockResult || result || {}
        },
      });
    } else {
      // All installments paid! Remove lock completely.
      const result = await pt.removeLock({ imei: imeiSerial, deviceTag: device.device_tag || '' });
      console.log('[PayTrigger] removeLock ok:', result?.code, result?.message);

      if (result?.code !== 200) {
        await prisma.payTriggerDevice.update({
          where: { imei: imeiSerial },
          data: { last_sync_at: now(), raw_state: result || {} },
        });
        alertSyncFailure(order, `loan fully paid but PayTrigger did not confirm lock removal for IMEI ${imeiSerial} (removeLock: ${result?.code}/${result?.message}).`);
        return;
      }

      await prisma.payTriggerDevice.update({
        where: { imei: imeiSerial },
        data: {
          lock_status: 'unlocked',
          server_state: 5000,
          enrollment_status: 'removable',
          last_sync_at: now(),
          raw_state: result || {},
        },
      });
    }
  } catch (e) {
    console.error('[PayTrigger] repay/unlock sync failed:', e.message);
    alertSyncFailure(order, `payment recorded but the PayTrigger unlock sync threw an error (${e.message}).`);
  }
}

module.exports = { syncPayTriggerAfterPayment };
