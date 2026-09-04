const prisma = require('../../lib/prisma');
const { getScoringConfig } = require('../utils/scoringConfigUtils');

const now = () => new Date();

async function updateVerificationRanking(officerId, periodType = 'month') {
    const nowDate = new Date();
    let start, end;

    if (periodType === 'month') {
        start = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1, 0, 0, 0, 0);
        end = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (periodType === 'today') {
        start = new Date(nowDate); start.setHours(0, 0, 0, 0);
        end = new Date(nowDate); end.setHours(23, 59, 59, 999);
    } else if (periodType === 'week') {
        const day = nowDate.getDay();
        const diff = nowDate.getDate() - day + (day === 0 ? -6 : 1);
        start = new Date(nowDate.setDate(diff)); start.setHours(0, 0, 0, 0);
        end = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
    }

    // assigned_to_user_id is the verification officer
    const orders = await prisma.order.findMany({
        where: {
            assigned_to_user_id: officerId,
            updated_at: { gte: start, lte: end }
        },
        include: {
            verification: true
        }
    });

    const uniqueCustomersCount = orders.length;

    let deliveredCount = 0;
    let completedCount = 0;
    let returnedCount = 0;
    let cancelledCount = 0;
    let expiredCount = 0;
    let totalSales = 0;

    orders.forEach(order => {
        if (order.status === 'delivered') {
            deliveredCount++;
            totalSales += (order.total_amount || 0);
        }
        if (order.status === 'completed' || order.status === 'approved') completedCount++;
        if (order.status === 'returned') returnedCount++;
        if (order.status === 'cancelled') cancelledCount++;
        if (order.status === 'expired') expiredCount++;
    });

    // Configurable Score Formula for Verification Officer
    const cfg = getScoringConfig().verification;
    const score = 
        (completedCount * (cfg.points_per_completed_verification || 10)) + 
        (deliveredCount * (cfg.points_per_delivered_order || 5)) - 
        (returnedCount * (cfg.points_deducted_per_returned_order || 5)) - 
        (cancelledCount * (cfg.points_deducted_per_cancelled_order || 2)) - 
        (expiredCount * (cfg.points_deducted_per_expired_order || 3));

    const existingRanking = await prisma.verificationRanking.findUnique({
        where: {
            officer_id_period_month_year: {
                officer_id: officerId,
                period: periodType,
                month: periodType === 'month' ? nowDate.getMonth() + 1 : 0,
                year: periodType === 'month' ? nowDate.getFullYear() : 0
            }
        }
    });

    let trend = existingRanking?.trend || 0;
    if (existingRanking && score !== existingRanking.score) {
        trend = score > existingRanking.score ? 1 : -1;
    }

    const ranking = await prisma.verificationRanking.upsert({
        where: {
            officer_id_period_month_year: {
                officer_id: officerId,
                period: periodType,
                month: periodType === 'month' ? nowDate.getMonth() + 1 : 0,
                year: periodType === 'month' ? nowDate.getFullYear() : 0
            }
        },
        update: {
            unique_customers: uniqueCustomersCount,
            delivered_customers: deliveredCount,
            completed_customers: completedCount,
            cancelled_customers: cancelledCount,
            expired_customers: expiredCount,
            total_sales: totalSales,
            score: score,
            trend: trend,
            updated_at: now()
        },
        create: {
            officer_id: officerId,
            period: periodType,
            month: periodType === 'month' ? nowDate.getMonth() + 1 : 0,
            year: periodType === 'month' ? nowDate.getFullYear() : 0,
            unique_customers: uniqueCustomersCount,
            delivered_customers: deliveredCount,
            completed_customers: completedCount,
            cancelled_customers: cancelledCount,
            expired_customers: expiredCount,
            total_sales: totalSales,
            score: score,
            trend: 0,
            updated_at: now()
        }
    });

    return ranking;
}

module.exports = { updateVerificationRanking };
