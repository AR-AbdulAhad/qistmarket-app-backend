const prisma = require('../../lib/prisma');
const { syncBlacklistStatus, notifyBlacklistedOrder } = require('../utils/blacklistUtils');
const { logAction } = require('../utils/auditLogger');

// Notifies every delivered order under this CNIC with a live ledger —
// normally one, but a repeat customer can have more than one order on file.
async function notifyManualBlacklist(cnic) {
    try {
        const purchaserRecords = await prisma.purchaserVerification.findMany({
            where: { cnic_number: cnic },
            include: {
                verification: {
                    include: {
                        grantors: true,
                        order: { include: { delivery: { include: { installment_ledger: true } } } },
                    },
                },
            },
        });

        for (const pv of purchaserRecords) {
            const order = pv.verification?.order;
            if (!order || !order.is_delivered) continue;
            const rows = order.delivery?.installment_ledger?.ledger_rows;
            if (!Array.isArray(rows)) continue;

            notifyBlacklistedOrder({ ...order, verification: { purchaser: pv, grantors: pv.verification.grantors } }, rows)
                .catch((e) => console.error('[Blacklist] notify error:', e));
        }
    } catch (e) {
        console.error('[Blacklist] notifyManualBlacklist error:', e);
    }
}

/**
 * searchByCnicOrPhone
 * Look up a person's current blacklist status + verification records by
 * CNIC or phone, regardless of whether they're currently blacklisted —
 * so an Accountant can whitelist someone or blacklist someone who doesn't
 * (yet) meet the automatic 90-day criteria.
 */
const searchByCnicOrPhone = async (req, res) => {
    try {
        const { query } = req.query;
        if (!query || query.trim().length < 3) {
            return res.status(400).json({ success: false, message: 'Please provide at least 3 characters to search.' });
        }
        const q = query.trim();

        const [purchasers, grantors] = await Promise.all([
            prisma.purchaserVerification.findMany({
                where: { OR: [{ cnic_number: { contains: q } }, { telephone_number: { contains: q } }, { name: { contains: q } }] },
                select: { id: true, verification_id: true, name: true, cnic_number: true, telephone_number: true, is_blacklisted: true },
                take: 20,
            }),
            prisma.grantorVerification.findMany({
                where: { OR: [{ cnic_number: { contains: q } }, { telephone_number: { contains: q } }, { name: { contains: q } }] },
                select: { id: true, verification_id: true, name: true, cnic_number: true, telephone_number: true, is_blacklisted: true },
                take: 20,
            }),
        ]);

        const results = [
            ...purchasers.map((p) => ({ ...p, role: 'Purchaser' })),
            ...grantors.map((g) => ({ ...g, role: 'Grantor' })),
        ];

        res.json({ success: true, data: results });
    } catch (error) {
        console.error('searchByCnicOrPhone error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * setBlacklistStatus
 * Manually blacklist or whitelist a CNIC, with structured fraud tagging
 * (category) and an approval gate: blacklisting is immediate (flagging a
 * risk should never wait). Whitelisting normally starts "pending" and only
 * takes effect once a second call approves it via approveBlacklistAction —
 * a real approval workflow rather than a single person unilaterally
 * clearing someone — EXCEPT when an Admin/Super Admin requests it: they
 * already are the final approval authority, so there is nobody "above" them
 * to approve a second time, and requiring one just made whitelisting from
 * the admin's own Blacklisted Accounts page silently do nothing until an
 * accountant separately opened Pending Approvals. For Admin/Super Admin the
 * whitelist takes effect immediately, same as blacklisting does. A
 * whitelist also protects the CNIC from being re-blacklisted by the
 * automatic 90-day sync (see blacklistUtils.js), whether applied instantly
 * here or via later approval.
 */
const setBlacklistStatus = async (req, res) => {
    try {
        const { cnic, action, reason, category } = req.body;
        if (!cnic || !['blacklist', 'whitelist'].includes(action)) {
            return res.status(400).json({ success: false, message: 'cnic and a valid action (blacklist/whitelist) are required.' });
        }
        if (action === 'blacklist' && !reason?.trim()) {
            return res.status(400).json({ success: false, message: 'Please provide a reason for blacklisting the customer.' });
        }

        const cleanCnic = cnic.trim();

        if (action === 'blacklist') {
            await prisma.$transaction([
                prisma.purchaserVerification.updateMany({ where: { cnic_number: cleanCnic }, data: { is_blacklisted: true } }),
                prisma.grantorVerification.updateMany({ where: { cnic_number: cleanCnic }, data: { is_blacklisted: true } }),
                prisma.blacklistAction.create({
                    data: { cnic: cleanCnic, action, category: category || null, reason: reason || null, status: 'approved', approved_by_id: req.user.id, approved_at: new Date(), created_by_id: req.user.id },
                }),
            ]);
            await logAction(req, 'MANUAL_BLACKLIST', `CNIC ${cleanCnic} manually blacklisted. ${category ? `Category: ${category}. ` : ''}${reason ? 'Reason: ' + reason : ''}`, null, 'BlacklistAction');
            notifyManualBlacklist(cleanCnic);
            return res.json({ success: true, message: 'Customer blacklisted.' });
        }

        const requesterRole = (req.user?.role || '').toLowerCase();
        const isTopAuthority = ['admin', 'super admin'].includes(requesterRole);

        if (isTopAuthority) {
            const approvedAction = await prisma.$transaction(async (tx) => {
                const created = await tx.blacklistAction.create({
                    data: { cnic: cleanCnic, action: 'whitelist', category: category || null, reason: reason || null, status: 'approved', created_by_id: req.user.id, approved_by_id: req.user.id, approved_at: new Date() },
                });
                await tx.purchaserVerification.updateMany({ where: { cnic_number: cleanCnic }, data: { is_blacklisted: false } });
                await tx.grantorVerification.updateMany({ where: { cnic_number: cleanCnic }, data: { is_blacklisted: false } });
                return created;
            });
            await logAction(req, 'MANUAL_WHITELIST_APPROVED', `CNIC ${cleanCnic} whitelisted immediately by ${requesterRole}. ${reason ? 'Reason: ' + reason : ''}`, approvedAction.id, 'BlacklistAction');
            return res.json({ success: true, message: 'Customer whitelisted.', data: approvedAction });
        }

        // Everyone else: whitelist requests start pending — is_blacklisted is NOT flipped here.
        const pendingAction = await prisma.blacklistAction.create({
            data: { cnic: cleanCnic, action: 'whitelist', category: category || null, reason: reason || null, status: 'pending', created_by_id: req.user.id },
        });
        await logAction(req, 'MANUAL_WHITELIST_REQUESTED', `Whitelist requested for CNIC ${cleanCnic}, pending approval. ${reason ? 'Reason: ' + reason : ''}`, pendingAction.id, 'BlacklistAction');

        res.json({ success: true, message: 'Whitelist request submitted for approval.', data: pendingAction });
    } catch (error) {
        console.error('setBlacklistStatus error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * approveBlacklistAction
 * Approves a pending whitelist request — only now does is_blacklisted
 * actually flip to false and the auto-sync protection kick in.
 */
const approveBlacklistAction = async (req, res) => {
    try {
        const { id } = req.params;
        const action = await prisma.blacklistAction.findUnique({ where: { id: parseInt(id) } });
        if (!action) return res.status(404).json({ success: false, message: 'Request not found.' });
        if (action.status !== 'pending') return res.status(400).json({ success: false, message: 'This request has already been decided.' });

        await prisma.$transaction([
            prisma.purchaserVerification.updateMany({ where: { cnic_number: action.cnic }, data: { is_blacklisted: false } }),
            prisma.grantorVerification.updateMany({ where: { cnic_number: action.cnic }, data: { is_blacklisted: false } }),
            prisma.blacklistAction.update({ where: { id: action.id }, data: { status: 'approved', approved_by_id: req.user.id, approved_at: new Date() } }),
        ]);

        await logAction(req, 'MANUAL_WHITELIST_APPROVED', `Whitelist approved for CNIC ${action.cnic}.`, action.id, 'BlacklistAction');

        res.json({ success: true, message: 'Whitelist approved.' });
    } catch (error) {
        console.error('approveBlacklistAction error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const rejectBlacklistAction = async (req, res) => {
    try {
        const { id } = req.params;
        const action = await prisma.blacklistAction.update({
            where: { id: parseInt(id) },
            data: { status: 'rejected', approved_by_id: req.user.id, approved_at: new Date() },
        });
        await logAction(req, 'MANUAL_WHITELIST_REJECTED', `Whitelist request rejected for CNIC ${action.cnic}.`, action.id, 'BlacklistAction');
        res.json({ success: true, message: 'Whitelist request rejected.' });
    } catch (error) {
        console.error('rejectBlacklistAction error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getPendingWhitelistRequests = async (req, res) => {
    try {
        const requests = await prisma.blacklistAction.findMany({
            where: { action: 'whitelist', status: 'pending' },
            include: { created_by: { select: { full_name: true } } },
            orderBy: { created_at: 'desc' },
        });
        res.json({ success: true, data: requests });
    } catch (error) {
        console.error('getPendingWhitelistRequests error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getCustomerRiskScore
 * Simple explainable risk score (0-100, higher = riskier) for one CNIC,
 * built from blacklist status, missed-installment count, and manual
 * fraud-category flags — the per-customer counterpart to
 * accountsReceivablesController.getReceivablesRiskAnalysis's global tiers.
 */
const getCustomerRiskScore = async (req, res) => {
    try {
        const { cnic } = req.params;
        const cleanCnic = cnic.trim();

        const [purchaser, actions] = await Promise.all([
            prisma.purchaserVerification.findFirst({ where: { cnic_number: cleanCnic } }),
            prisma.blacklistAction.findMany({ where: { cnic: cleanCnic }, orderBy: { created_at: 'desc' } }),
        ]);

        let score = 0;
        const factors = [];

        if (purchaser?.is_blacklisted) { score += 50; factors.push('Currently blacklisted'); }

        const fraudFlags = actions.filter((a) => a.category === 'fraud');
        if (fraudFlags.length > 0) { score += 30; factors.push(`${fraudFlags.length} fraud tag(s) on record`); }

        const blacklistCount = actions.filter((a) => a.action === 'blacklist').length;
        if (blacklistCount >= 2) { score += 20; factors.push(`Blacklisted ${blacklistCount} times historically`); }

        score = Math.min(100, score);
        const tier = score >= 70 ? 'high' : score >= 30 ? 'medium' : 'low';

        res.json({ success: true, data: { cnic: cleanCnic, score, tier, factors, history: actions } });
    } catch (error) {
        console.error('getCustomerRiskScore error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getBlacklistHistory
 * Audit trail of manual blacklist/whitelist actions, optionally filtered by CNIC.
 */
const getBlacklistHistory = async (req, res) => {
    try {
        const { cnic } = req.query;
        const history = await prisma.blacklistAction.findMany({
            where: cnic ? { cnic: cnic.trim() } : {},
            include: { created_by: { select: { full_name: true } } },
            orderBy: { created_at: 'desc' },
            take: 200,
        });
        res.json({ success: true, data: history });
    } catch (error) {
        console.error('getBlacklistHistory error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * triggerSync
 * Manually re-run the automatic 90-day blacklist sync on demand
 * (it also runs implicitly whenever the blacklist list is viewed).
 */
const triggerSync = async (req, res) => {
    try {
        const result = await syncBlacklistStatus();
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('triggerSync error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getBlacklistStatusForCnic
 * Deliberately NOT gated behind requireAccountant — this is a lightweight,
 * non-sensitive status check (just booleans + last action date, no reasons/
 * amounts) that CustomerProfileModal calls from every role/portal that opens
 * a customer profile, so a whitelisted customer shows a "Previously
 * Blacklisted" tag wherever their profile is viewed, not only on the
 * Accountant/Admin blacklist pages.
 */
const getBlacklistStatusForCnic = async (req, res) => {
    try {
        const { cnic } = req.params;
        if (!cnic || !cnic.trim()) {
            return res.status(400).json({ success: false, message: 'cnic is required.' });
        }
        const cleanCnic = cnic.trim();

        const [purchaser, lastBlacklistAction] = await Promise.all([
            prisma.purchaserVerification.findFirst({ where: { cnic_number: cleanCnic }, select: { is_blacklisted: true } }),
            prisma.blacklistAction.findFirst({
                where: { cnic: cleanCnic, action: 'blacklist' },
                orderBy: { created_at: 'desc' },
                select: { created_at: true },
            }),
        ]);

        res.json({
            success: true,
            data: {
                isBlacklisted: purchaser?.is_blacklisted || false,
                wasEverBlacklisted: !!lastBlacklistAction,
                lastBlacklistedAt: lastBlacklistAction?.created_at || null,
            },
        });
    } catch (error) {
        console.error('getBlacklistStatusForCnic error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    searchByCnicOrPhone,
    setBlacklistStatus,
    approveBlacklistAction,
    rejectBlacklistAction,
    getPendingWhitelistRequests,
    getCustomerRiskScore,
    getBlacklistHistory,
    triggerSync,
    getBlacklistStatusForCnic,
};
