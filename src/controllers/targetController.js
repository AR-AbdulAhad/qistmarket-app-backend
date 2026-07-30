const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const getTargets = async (req, res) => {
    try {
        const { month, officer_id } = req.query;
        let where = {};
        if (month) where.month = month;
        if (officer_id) where.officer_id = parseInt(officer_id);

        const targets = await prisma.officerTarget.findMany({
            where: {
                ...where,
                ...(req.user.outlet_id ? { officer: { outlet_id: req.user.outlet_id } } : {})
            },
            include: {
                officer: { select: { id: true, username: true, full_name: true, role: { select: { name: true } } } },
                created_by: { select: { id: true, username: true, full_name: true } }
            },
            orderBy: { created_at: 'desc' }
        });

        res.json({ success: true, targets });
    } catch (error) {
        console.error('getTargets error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const assignTarget = async (req, res) => {
    try {
        const { officer_id, month, target_amount, target_customers } = req.body;

        if (!officer_id || !month || target_amount === undefined || target_customers === undefined) {
            return res.status(400).json({ success: false, message: 'Missing required fields.' });
        }

        const existingTarget = await prisma.officerTarget.findUnique({
            where: {
                officer_id_month: { officer_id: parseInt(officer_id), month }
            }
        });

        if (existingTarget) {
            return res.status(400).json({ success: false, message: `A target has already been assigned for this officer in ${month}. Targets are not editable once set.` });
        }

        if (req.user.outlet_id) {
            const officer = await prisma.user.findUnique({ where: { id: parseInt(officer_id) }, select: { outlet_id: true } });
            if (!officer || officer.outlet_id !== req.user.outlet_id) {
                return res.status(403).json({ success: false, message: 'You can only assign targets to officers in your own outlet.' });
            }
        }

        const newTarget = await prisma.officerTarget.create({
            data: {
                officer_id: parseInt(officer_id),
                month,
                target_amount: parseFloat(target_amount),
                target_customers: parseInt(target_customers),
                created_by_id: req.user?.id || null
            }
        });

        res.json({ success: true, message: 'Target assigned successfully.', target: newTarget });
    } catch (error) {
        console.error('assignTarget error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getTargets,
    assignTarget
};
