const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const getOfficerAssignments = async (req, res) => {
    const { role } = req.query;
    try {
        const roleName = role === 'delivery' ? 'Delivery Agent' : 'Verification Officer';
        const officers = await prisma.user.findMany({
            where: { role: { name: roleName } },
            select: {
                id: true,
                full_name: true,
                username: true,
                officerAssignments: true,
            },
            orderBy: { full_name: 'asc' },
        });

        return res.json({ success: true, data: officers });
    } catch (error) {
        console.error('getOfficerAssignments error:', error);
        return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
};

const updateOfficerAssignments = async (req, res) => {
    const { officerId } = req.params;
    const { assignments } = req.body; // Array of { zone, area }

    try {
        // Delete existing assignments for this officer
        await prisma.officerAreaAssignment.deleteMany({
            where: { user_id: parseInt(officerId) }
        });

        // Create new assignments
        if (assignments && assignments.length > 0) {
            await prisma.officerAreaAssignment.createMany({
                data: assignments.map(a => ({
                    user_id: parseInt(officerId),
                    zone: a.zone,
                    area: a.area,
                }))
            });
        }

        return res.json({ success: true, message: 'Assignments updated successfully' });
    } catch (error) {
        console.error('updateOfficerAssignments error:', error);
        return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
};

module.exports = {
    getOfficerAssignments,
    updateOfficerAssignments,
};
