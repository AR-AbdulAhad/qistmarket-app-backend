const prisma = require('../../lib/prisma');

// Helper for current timestamp
const now = () => new Date();

/**
 * Identifies or creates a unique customer based on CNIC or Mobile Number.
 */
async function getOrCreateCustomer(orderId) {
    const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
            verification: {
                include: {
                    purchaser: true
                }
            }
        }
    });

    if (!order) return null;

    const cnic = order.verification?.purchaser?.cnic_number;
    const mobile = order.whatsapp_number;
    const name = order.customer_name;

    let customer = null;

    // Search by CNIC first
    if (cnic) {
        customer = await prisma.customer.findUnique({ where: { cnic } });
    }

    // Then search by Mobile
    if (!customer && mobile) {
        customer = await prisma.customer.findUnique({ where: { mobile } });
    }

    if (!customer) {
        customer = await prisma.customer.create({
            data: {
                cnic: cnic || null,
                mobile: mobile,
                name: name,
                created_at: now(),   // ✅ explicit created_at
                updated_at: now()    // ✅ explicit updated_at
            }
        });
    } else {
        // Sync CNIC if it was previously missing
        if (cnic && !customer.cnic) {
            customer = await prisma.customer.update({
                where: { id: customer.id },
                data: {
                    cnic,
                    updated_at: now()   // ✅ explicit updated_at
                }
            });
        }
    }

    // Link order to customer
    await prisma.order.update({
        where: { id: orderId },
        data: { customer_id: customer.id }
    });

    return customer;
}

/**
 * Checks if a customer is a repeat customer.
 * A repeat customer is one who has at least one previous 'delivered' or 'completed' order.
 */
async function checkRepeatStatus(customerId, currentOrderId) {
    const previousSuccessOrder = await prisma.order.findFirst({
        where: {
            customer_id: customerId,
            id: { not: currentOrderId },
            status: { in: ['delivered', 'completed'] }
        }
    });

    return !!previousSuccessOrder;
}

/**
 * Recalculates ranking for a CSR for a specific period.
 */
async function updateCsrRanking(csrId, periodType = 'month') {
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
        const diff = nowDate.getDate() - day + (day === 0 ? -6 : 1); // Monday
        start = new Date(nowDate.setDate(diff)); start.setHours(0, 0, 0, 0);
        end = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
    }

    // Delivered orders are matched on delivered_at (frozen at the moment of
    // delivery), not updated_at — same convention getOrders' dateRange filter
    // already uses for the Delivered/Completed Orders lists. Matching on
    // updated_at alone let an order delivered last month but touched again
    // this month (or vice versa) count in the wrong period here while the
    // visible order list — which the CSR compares this "Done" figure
    // against — used the correct date, producing a mismatch between the two.
    const orders = await prisma.order.findMany({
        where: {
            created_by_user_id: csrId,
            OR: [
                { status: 'delivered', delivered_at: { gte: start, lte: end } },
                { status: 'delivered', delivered_at: null, updated_at: { gte: start, lte: end } },
                { status: { not: 'delivered' }, updated_at: { gte: start, lte: end } },
            ],
        },
        include: {
            customer: true
        }
    });

    // Count every order as a customer-style entry so a single customer with multiple orders
    // contributes once per order, not once overall.
    const uniqueCustomersCount = orders.length;

    // Per-order counts (not deduped by customer) — so "Done" etc. always match
    // the exact number of rows the CSR sees on the corresponding Delivered /
    // Cancelled / Expired Orders list for the same period, same as
    // updateDeliveryRanking below already does for delivery officers.
    let deliveredCount = 0;
    let completedCount = 0;
    let returnedCount = 0;
    let repeatCount = 0;
    let cancelledCount = 0;
    let expiredCount = 0;
    let totalSales = 0;

    orders.forEach(order => {
        if (order.status === 'delivered') {
            deliveredCount++;
            totalSales += (order.total_amount || 0);
        }
        if (order.status === 'completed') completedCount++;
        if (order.status === 'returned') returnedCount++;
        if (order.status === 'cancelled') cancelledCount++;
        if (order.status === 'expired') expiredCount++;
        if (order.is_repeat_customer) repeatCount++;
    });

    // Fetch Solved Complaints for the CSR in the period
    const solvedComplaintsCount = await prisma.complaint.count({
        where: {
            assigned_to_user_id: csrId,
            status: 'Solved',
            updated_at: { gte: start, lte: end }
        }
    });

    // Dynamic Admin-Configured Scoring Formula for CSR (Supports Per-Officer Overrides)
    const { getEffectiveScoringRules } = require('../utils/scoringConfigUtils');
    const csrRules = getEffectiveScoringRules('csr', 'officer', csrId);
    const score = (deliveredCount * (csrRules.points_per_delivered_order ?? 10)) +
                  (repeatCount * (csrRules.points_per_repeat_customer ?? 5)) +
                  (completedCount * (csrRules.points_per_completed_order ?? 5)) +
                  (solvedComplaintsCount * (csrRules.points_per_solved_complaint ?? 1)) -
                  (returnedCount * (csrRules.points_deducted_per_returned_order ?? 5)) -
                  (cancelledCount * (csrRules.points_deducted_per_cancelled_order ?? 1)) -
                  (expiredCount * (csrRules.points_deducted_per_expired_order ?? 3));

    // Fetch existing ranking to calculate trend
    const existingRanking = await prisma.csrRanking.findUnique({
        where: {
            csr_id_period_month_year: {
                csr_id: csrId,
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

    // Update Snapshot
    const ranking = await prisma.csrRanking.upsert({
        where: {
            csr_id_period_month_year: {
                csr_id: csrId,
                period: periodType,
                month: periodType === 'month' ? nowDate.getMonth() + 1 : 0,
                year: periodType === 'month' ? nowDate.getFullYear() : 0
            }
        },
        update: {
            unique_customers: uniqueCustomersCount,
            delivered_customers: deliveredCount,
            completed_customers: completedCount,
            repeat_customers: repeatCount,
            cancelled_customers: cancelledCount,
            expired_customers: expiredCount,
            total_sales: totalSales,
            score: score,
            trend: trend,
            updated_at: now()   // ✅ explicit updated_at
        },
        create: {
            csr_id: csrId,
            period: periodType,
            month: periodType === 'month' ? nowDate.getMonth() + 1 : 0,
            year: periodType === 'month' ? nowDate.getFullYear() : 0,
            unique_customers: uniqueCustomersCount,
            delivered_customers: deliveredCount,
            completed_customers: completedCount,
            repeat_customers: repeatCount,
            cancelled_customers: cancelledCount,
            expired_customers: expiredCount,
            total_sales: totalSales,
            score: score,
            trend: 0,
            updated_at: now()   // ✅ explicit updated_at (since model has only updated_at)
        }
    });

    return ranking;
}

/**
 * Calculates working days left in the current month, skipping Sundays.
 */
function getWorkingDaysLeftInMonth() {
    const nowDate = new Date();
    const lastDay = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 0);

    let workingDays = 0;
    let current = new Date(nowDate);
    // Start from tomorrow
    current.setDate(current.getDate() + 1);

    while (current <= lastDay) {
        if (current.getDay() !== 0) { // Skip Sunday
            workingDays++;
        }
        current.setDate(current.getDate() + 1);
    }

    return workingDays || 1; // At least 1 to avoid division by zero
}

/**
 * Recalculates ranking for a Delivery Officer for a specific period.
 */
async function updateDeliveryRanking(officerId, periodType = 'month') {
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

    const deliveries = await prisma.delivery.findMany({
        where: {
            delivery_agent_id: officerId,
            updated_at: { gte: start, lte: end }
        },
        include: {
            order: {
                include: { customer: true }
            }
        }
    });

    const uniqueCustomersCount = deliveries.length;

    let deliveredCount = 0;
    let completedCount = 0;
    let repeatCount = 0;
    let cancelledCount = 0;
    let expiredCount = 0;
    let totalSales = 0;

    deliveries.forEach(d => {
        if (d.status === 'delivered') {
            deliveredCount++;
            totalSales += (d.order?.total_amount || 0);
        }
        if (d.status === 'completed') completedCount++;
        if (d.status === 'cancelled') cancelledCount++;
        if (d.status === 'expired') expiredCount++;
        if (d.order?.is_repeat_customer) repeatCount++;
    });

    // Dynamic Admin-Configured Score logic for Delivery Agent
    const deliveryRules = getScoringConfig().delivery;
    const score = (deliveredCount * (deliveryRules.points_per_delivered_order ?? 15)) +
                  (completedCount * (deliveryRules.points_per_completed_order ?? 5)) -
                  (cancelledCount * (deliveryRules.points_deducted_per_cancelled_order ?? 2)) -
                  (expiredCount * (deliveryRules.points_deducted_per_expired_order ?? 3));

    const existingRanking = await prisma.deliveryRanking.findUnique({
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

    const ranking = await prisma.deliveryRanking.upsert({
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
            repeat_customers: repeatCount,
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
            repeat_customers: repeatCount,
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

module.exports = {
    getOrCreateCustomer,
    checkRepeatStatus,
    updateCsrRanking,
    getWorkingDaysLeftInMonth,
    updateDeliveryRanking
};