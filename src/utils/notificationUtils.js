const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Notify all active admins
 */
const notifyAdmins = async (title, message, type, relatedId = null, io = null) => {
    try {
        const admins = await prisma.user.findMany({
            where: {
                role_id: { in: [4, 5, 6, 7, 8] },
                status: 'active'
            },
            select: { id: true }
        });

        if (admins.length === 0) return;

        const notificationData = admins.map(admin => ({
            userId: admin.id,
            title,
            message,
            type,
            relatedId: relatedId ? parseInt(relatedId) : null,
            createdAt: new Date()
        }));

        await prisma.notification.createMany({ data: notificationData });

        if (io) {
            io.to('admins').emit('new_notification', {
                title,
                message,
                type,
                relatedId,
                timestamp: new Date().toISOString(),
            });
        }
    } catch (err) {
        console.error('Failed to notify admins:', err);
    }
};

/**
 * Notify a specific user
 */
const notifyUser = async (userId, title, message, type, relatedId = null, io = null) => {
    try {
        await prisma.notification.create({
            data: {
                userId: parseInt(userId),
                title,
                message,
                type,
                relatedId: relatedId ? parseInt(relatedId) : null,
                createdAt: new Date()
            }
        });

        if (io) {
            io.to(`user_${userId}`).emit('new_notification', {
                title,
                message,
                type,
                relatedId,
                timestamp: new Date().toISOString(),
            });
        }
    } catch (err) {
        console.error(`Failed to notify user ${userId}:`, err);
    }
};

module.exports = {
    notifyAdmins,
    notifyUser
};
