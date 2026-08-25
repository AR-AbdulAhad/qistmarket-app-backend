const prisma = require('../../lib/prisma');
const { getNormalizedLedger } = require('./ledgerUtils');
const { sendMarkBlacklist, sendGuarantorNotice } = require('../services/watiService');

/**
 * Sends the "mark_blacklist" WATI message to the customer, and "guarantor_notice"
 * to every grantor on the account, once that account has just been blacklisted.
 * Called from both the automatic 90-day sync and the manual staff action —
 * centralised here since both need the same outstanding-balance /
 * earliest-overdue-date lookup from the order's ledger, and both blacklist
 * the purchaser AND every linked grantor together in one operation.
 */
async function notifyBlacklistedOrder(order, ledgerRows) {
  const rows = Array.isArray(ledgerRows) ? ledgerRows : [];
  const outstandingAmount = getNormalizedLedger(rows).summary.grandTotalRemaining;
  const itemName = order.product_name;
  const orderRef = order.order_ref;
  const ledgerUrl = order.delivery?.installment_ledger?.short_id || null;
  const customerName = order.verification?.purchaser?.name || order.customer_name;

  try {
    const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
    if (phone) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const overdueRows = rows
        .filter((r) => {
          if ((r.status || '').toLowerCase() === 'paid') return false;
          const d = r.due_date || r.dueDate;
          const dDate = d ? new Date(d) : null;
          return dDate && !isNaN(dDate.getTime()) && dDate < today;
        })
        .sort((a, b) => new Date(a.due_date || a.dueDate) - new Date(b.due_date || b.dueDate));
      const overdueDate = overdueRows[0]
        ? new Date(overdueRows[0].due_date || overdueRows[0].dueDate).toLocaleDateString('en-PK')
        : null;

      const result = await sendMarkBlacklist(phone, {
        customerName,
        itemName,
        orderRef,
        outstandingAmount,
        overdueDate,
        ledgerUrl,
      });
      console.log('[WATI] Mark blacklist:', result?.success ? 'sent ✓' : result?.error);
    }
  } catch (e) {
    console.error('[blacklistUtils] notifyBlacklistedOrder (customer) error:', e);
  }

  const grantors = Array.isArray(order.verification?.grantors) ? order.verification.grantors : [];
  for (const grantor of grantors) {
    if (!grantor.telephone_number) continue;
    try {
      const result = await sendGuarantorNotice(grantor.telephone_number, {
        guarantorName: grantor.name,
        customerName,
        itemName,
        orderRef,
        outstandingAmount,
        ledgerUrl,
      });
      console.log('[WATI] Guarantor notice:', result?.success ? 'sent ✓' : result?.error);
    } catch (e) {
      console.error('[blacklistUtils] notifyBlacklistedOrder (grantor) error:', e);
    }
  }
}

/**
 * Automatically syncs the blacklist status for all delivered orders.
 * If an order meets the blacklist criteria (90 days overdue), it marks the purchaser
 * and all linked grantors as blacklisted in the database.
 */
async function syncBlacklistStatus() {
    try {
        const today = new Date();
        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(today.getDate() - 90);

        // Fetch all delivered orders that have an installment ledger
        const orders = await prisma.order.findMany({
            where: { is_delivered: true },
            include: {
                verification: {
                    include: {
                        purchaser: true,
                        grantors: true
                    }
                },
                delivery: {
                    include: {
                        installment_ledger: true
                    }
                }
            }
        });

        // Manually whitelisted CNICs (most recent action = 'whitelist') are protected
        // from being re-blacklisted by this automatic sync.
        const overrideActions = await prisma.blacklistAction.findMany({ orderBy: { created_at: 'desc' } });
        const latestActionByCnic = {};
        for (const o of overrideActions) {
            if (!(o.cnic in latestActionByCnic)) latestActionByCnic[o.cnic] = o.action;
        }
        const whitelistedCnics = new Set(
            Object.entries(latestActionByCnic).filter(([, action]) => action === 'whitelist').map(([cnic]) => cnic)
        );

        const blacklistedVerificationIds = [];
        // Only accounts crossing from not-blacklisted to blacklisted THIS run
        // get notified — re-running the sync must not re-notify someone who
        // was already flagged on a previous pass.
        const newlyBlacklistedOrders = [];

        for (const order of orders) {
            const purchaserCnic = order.verification?.purchaser?.cnic_number;
            if (purchaserCnic && whitelistedCnics.has(purchaserCnic)) continue;

            const ledgerModel = order.delivery?.installment_ledger;
            if (!ledgerModel || !ledgerModel.ledger_rows) continue;

            let rows = [];
            try {
                rows = Array.isArray(ledgerModel.ledger_rows)
                    ? ledgerModel.ledger_rows
                    : JSON.parse(ledgerModel.ledger_rows);
            } catch (e) { continue; }

            if (!Array.isArray(rows)) continue;

            const installments = rows.filter(r => r.month > 0);
            if (installments.length === 0) continue;

            let isBlacklisted = false;

            // Condition 1: No installments paid for 90 days since delivery
            const paidCount = installments.filter(r => r.status === 'paid' || r.status === 'Paid').length;
            const deliveryDate = new Date(order.delivery?.end_time || order.updated_at);
            if (paidCount === 0 && deliveryDate < ninetyDaysAgo) {
                isBlacklisted = true;
            }

            // Condition 2: Any installment overdue > 90 days
            if (!isBlacklisted) {
                isBlacklisted = installments.some(r => {
                    const dDate = r.due_date || r.dueDate;
                    if (!dDate) return false;
                    const dueDate = new Date(dDate);
                    return (r.status !== 'paid' && r.status !== 'Paid') && dueDate < ninetyDaysAgo;
                });
            }

            if (isBlacklisted && order.verification?.id) {
                blacklistedVerificationIds.push(order.verification.id);
                if (!order.verification?.purchaser?.is_blacklisted) {
                    newlyBlacklistedOrders.push({ order, rows });
                }
            }
        }

        if (blacklistedVerificationIds.length > 0) {
            // Update PurchaserVerification
            await prisma.purchaserVerification.updateMany({
                where: { verification_id: { in: blacklistedVerificationIds } },
                data: { is_blacklisted: true }
            });

            // Update GrantorVerification
            await prisma.grantorVerification.updateMany({
                where: { verification_id: { in: blacklistedVerificationIds } },
                data: { is_blacklisted: true }
            });

            console.log(`[BlacklistSync] Successfully blacklisted ${blacklistedVerificationIds.length} verifications.`);

            for (const { order, rows } of newlyBlacklistedOrders) {
                notifyBlacklistedOrder(order, rows).catch((e) => console.error('[BlacklistSync] notify error:', e));
            }
        }

        return { success: true, count: blacklistedVerificationIds.length };
    } catch (error) {
        console.error('[BlacklistSync] Error syncing blacklist status:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Checks if a name or CNIC is blacklisted.
 * Searches both PurchaserVerification and GrantorVerification.
 */
async function checkBlacklistStatus(cnic) {
    if (!cnic) return { isBlacklisted: false };

    const cleanCnic = cnic.trim();

    // Check PurchaserVerification
    const blacklistedPurchaser = await prisma.purchaserVerification.findFirst({
        where: {
            OR: [
                { cnic_number: cleanCnic },
            ],
            is_blacklisted: true
        }
    });

    if (blacklistedPurchaser) return { isBlacklisted: true, personType: 'Purchaser', details: blacklistedPurchaser };

    // Check GrantorVerification
    const blacklistedGrantor = await prisma.grantorVerification.findFirst({
        where: {
            OR: [
                { cnic_number: cleanCnic },
            ],
            is_blacklisted: true
        }
    });

    if (blacklistedGrantor) return { isBlacklisted: true, personType: 'Grantor', details: blacklistedGrantor };

    return { isBlacklisted: false };
}

module.exports = {
    syncBlacklistStatus,
    checkBlacklistStatus,
    notifyBlacklistedOrder
};
