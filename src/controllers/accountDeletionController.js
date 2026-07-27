const prisma = require('../../lib/prisma');
const { logAction } = require('../utils/auditLogger');

/**
 * requestAccountDeletion
 * Self-service — any authenticated user can request their own account be
 * deleted. One pending request at a time; re-requesting while a request is
 * already pending is rejected rather than creating duplicates.
 */
const requestAccountDeletion = async (req, res) => {
    const { reason } = req.body;

    try {
        const existing = await prisma.accountDeletionRequest.findFirst({
            where: { userId: req.user.id, status: 'pending' },
        });
        if (existing) {
            return res.status(400).json({ success: false, message: 'You already have a pending deletion request.' });
        }

        const request = await prisma.accountDeletionRequest.create({
            data: { userId: req.user.id, reason: reason || null },
        });

        await logAction(req, 'ACCOUNT_DELETION_REQUESTED', `${req.user.full_name || req.user.username} requested account deletion.${reason ? ` Reason: ${reason}` : ''}`, request.id, 'AccountDeletionRequest');

        res.status(201).json({ success: true, data: { request } });
    } catch (error) {
        console.error('requestAccountDeletion error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getMyDeletionRequest
 * The logged-in user's own most recent deletion request, if any.
 */
const getMyDeletionRequest = async (req, res) => {
    try {
        const request = await prisma.accountDeletionRequest.findFirst({
            where: { userId: req.user.id },
            orderBy: { requestedAt: 'desc' },
        });

        res.json({ success: true, data: { request: request || null } });
    } catch (error) {
        console.error('getMyDeletionRequest error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getAllDeletionRequests
 * Admin-facing list, paginated, optionally filtered by status
 * (defaults to 'pending' — matches the frontend's default call).
 */
const getAllDeletionRequests = async (req, res) => {
    const { status = 'pending', page = 1, limit = 10 } = req.query;

    try {
        const where = status && status !== 'all' ? { status } : {};
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const take = parseInt(limit);

        const [requests, total] = await Promise.all([
            prisma.accountDeletionRequest.findMany({
                where,
                include: {
                    user: { select: { id: true, full_name: true, username: true, phone: true, role: { select: { name: true } } } },
                    reviewedBy: { select: { full_name: true, username: true } },
                },
                orderBy: { requestedAt: 'desc' },
                skip,
                take,
            }),
            prisma.accountDeletionRequest.count({ where }),
        ]);

        res.json({
            success: true,
            data: {
                requests,
                pagination: {
                    page: parseInt(page),
                    limit: take,
                    total,
                    totalPages: Math.ceil(total / take),
                    hasNext: skip + take < total,
                },
            },
        });
    } catch (error) {
        console.error('getAllDeletionRequests error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * reviewDeletionRequest
 * Admin approve/reject. Approval DEACTIVATES the account (status:
 * 'inactive') rather than hard-deleting the User row — a real delete would
 * either cascade into a large amount of business data (orders, deliveries,
 * recovery visits, etc.) or fail on the many relations that aren't
 * onDelete:Cascade. Deactivation is the safe, reversible equivalent of
 * "delete" for a record with this much history attached to it.
 */
const reviewDeletionRequest = async (req, res) => {
    const { id } = req.params;
    const { action, remarks } = req.body;

    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ success: false, message: "action must be 'approve' or 'reject'." });
    }

    try {
        const request = await prisma.accountDeletionRequest.findUnique({ where: { id: parseInt(id) } });
        if (!request) return res.status(404).json({ success: false, message: 'Deletion request not found.' });
        if (request.status !== 'pending') return res.status(400).json({ success: false, message: 'This request has already been reviewed.' });

        const updated = await prisma.accountDeletionRequest.update({
            where: { id: request.id },
            data: {
                status: action === 'approve' ? 'approved' : 'rejected',
                reviewedAt: new Date(),
                reviewedById: req.user.id,
                reviewRemarks: remarks || null,
            },
        });

        if (action === 'approve') {
            await prisma.user.update({ where: { id: request.userId }, data: { status: 'inactive', session_token: null } });
        }

        await logAction(req, `ACCOUNT_DELETION_${action.toUpperCase()}D`, `Account deletion request #${request.id} (user #${request.userId}) ${action}d.${remarks ? ` Remarks: ${remarks}` : ''}${action === 'approve' ? ' Account deactivated.' : ''}`, request.id, 'AccountDeletionRequest');

        res.json({ success: true, data: { request: updated } });
    } catch (error) {
        console.error('reviewDeletionRequest error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = { requestAccountDeletion, getMyDeletionRequest, getAllDeletionRequests, reviewDeletionRequest };
