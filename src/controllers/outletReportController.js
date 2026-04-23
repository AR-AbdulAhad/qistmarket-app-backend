const prisma = require('../../lib/prisma');

/**
 * Helper to get outlet filter based on user role and query
 */
const getOutletFilter = (req) => {
    const { outlet_id: userOutletId, role, role_id } = req.user;
    // Common admin role IDs: 4 (Admin), 5 (Super Admin)
    const isAdmin = ['admin', 'super admin'].includes(role?.toLowerCase()) || [4, 5].includes(role_id);
    
    if (isAdmin) {
        const queryOutletId = req.query.outletId || req.query.outlet_id;
        if (queryOutletId && queryOutletId !== 'all') {
            return { outlet_id: Number(queryOutletId) };
        }
        return {}; // All outlets
    }
    return { outlet_id: userOutletId };
};

/**
 * getDaybook
 * Aggregates all financial movements for the outlet on a specific date/range.
 */
const getDaybook = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const { startDate, endDate } = req.query;

    try {
        const dateFilter = {};
        if (startDate) dateFilter.gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        } else if (startDate) {
            const end = new Date(startDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        } else {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            dateFilter.gte = today;
            const end = new Date();
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        }

        // 1. Fetch Ledgers (Real-time income)
        const ledgers = await prisma.installmentLedger.findMany({
            where: {
                order: outletFilter,
            },
        });

        const payments = [];
        let totalIncome = 0;
        let totalAdvance = 0;
        let totalInstallments = 0;

        for (const ledger of ledgers) {
            const rows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : [];
            for (const row of rows) {
                if (row.status === 'paid' && row.paid_at) {
                    const paidDate = new Date(row.paid_at);
                    if (paidDate >= dateFilter.gte && paidDate <= dateFilter.lte) {
                        const amount = parseFloat(row.amount || row.dueAmount || 0);
                        totalIncome += amount;
                        if (row.month === 0) totalAdvance += amount;
                        else totalInstallments += amount;

                        payments.push({
                            ...row,
                            paymentType: row.month === 0 ? 'advance' : 'installment',
                            amount: amount,
                            paidAt: row.paid_at
                        });
                    }
                }
            }
        }

        // 2. Fetch Expenses (Real-time outgoing)
        const expenses = await prisma.expense.findMany({
            where: {
                ...outletFilter,
                created_at: dateFilter
            }
        });

        // 3. Summarize
        const summary = {
            totalIncome,
            totalExpense: expenses.reduce((acc, e) => acc + e.amount, 0),
            netCash: 0,
            breakdown: {
                advance: totalAdvance,
                installments: totalInstallments,
            }
        };
        summary.netCash = summary.totalIncome - summary.totalExpense;

        res.json({ success: true, data: { summary, payments, expenses } });
    } catch (error) {
        console.error('getDaybook error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getStockSummary
 * Summary of inventory items in the outlet.
 */
const getStockSummary = async (req, res) => {
    const outletFilter = getOutletFilter(req);

    try {
        const inventory = await prisma.outletInventory.findMany({
            where: outletFilter
        });

        const summary = inventory.reduce((acc, item) => {
            const key = item.product_name;
            if (!acc[key]) {
                acc[key] = {
                    product: key,
                    total: 0,
                    inStock: 0,
                    sold: 0,
                    valuation: 0
                };
            }
            acc[key].total++;
            if (item.status === 'In Stock') acc[key].inStock++;
            if (item.status === 'Sold') acc[key].sold++;
            acc[key].valuation += item.purchase_price;
            return acc;
        }, {});

        res.json({ success: true, data: Object.values(summary) });
    } catch (error) {
        console.error('getStockSummary error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getSalesReport
 * Detailed list of sales/orders for the outlet.
 */
const getSalesReport = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const { startDate, endDate, status } = req.query;

    try {
        const where = { ...outletFilter };
        if (startDate || endDate) {
            where.created_at = {};
            if (startDate) where.created_at.gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                where.created_at.lte = end;
            }
        }
        if (status) where.status = status;

        const orders = await prisma.order.findMany({
            where,
            include: {
                installment_ledger: true
            },
            orderBy: { created_at: 'desc' }
        });

        const summary = {
            totalOrders: orders.length,
            totalGrossAmount: orders.reduce((acc, o) => acc + o.total_amount, 0),
            totalReceived: orders.reduce((acc, o) => {
                const rows = Array.isArray(o.installment_ledger?.ledger_rows) ? o.installment_ledger.ledger_rows : [];
                return acc + rows.filter(r => r.status === 'paid').reduce((pAcc, p) => pAcc + (p.amount || 0), 0);
            }, 0)
        };

        res.json({ success: true, data: { summary, orders } });
    } catch (error) {
        console.error('getSalesReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getProfitLoss
 */
const getProfitLoss = async (req, res) => {
    const outletFilter = getOutletFilter(req);
    const { startDate, endDate } = req.query;

    try {
        const dateFilter = {};
        if (startDate) dateFilter.gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        }

        // 1. Find Orders in the range
        const orders = await prisma.order.findMany({
            where: {
                ...outletFilter,
                created_at: dateFilter,
                status: { notIn: ['Cancelled', 'Rejected'] }
            },
            select: {
                total_amount: true,
                imei_serial: true
            }
        });

        const totalRevenue = orders.reduce((acc, o) => acc + o.total_amount, 0);
        
        // 2. Find purchase prices for these items
        const imeiSerials = orders.map(o => o.imei_serial).filter(Boolean);
        const inventoryItems = await prisma.outletInventory.findMany({
            where: {
                imei_serial: { in: imeiSerials }
            },
            select: {
                purchase_price: true
            }
        });

        const totalCOGS = inventoryItems.reduce((acc, item) => acc + item.purchase_price, 0);
        const grossProfit = totalRevenue - totalCOGS;

        // 3. Subtract Expenses
        const expensesAgg = await prisma.expense.aggregate({
            where: { ...outletFilter, created_at: dateFilter },
            _sum: { amount: true }
        });
        const totalExpenses = expensesAgg._sum.amount || 0;

        res.json({
            success: true,
            data: {
                revenue: totalRevenue,
                cogs: totalCOGS,
                grossProfit,
                expenses: totalExpenses,
                netProfit: grossProfit - totalExpenses,
                orderCount: orders.length
            }
        });
    } catch (error) {
        console.error('getProfitLoss error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getCustomerLedger
 */
const getCustomerLedger = async (req, res) => {
    const { phone } = req.params;
    const outletFilter = getOutletFilter(req);

    try {
        const orders = await prisma.order.findMany({
            where: {
                whatsapp_number: phone,
                ...outletFilter
            },
            include: {
                installment_ledger: true
            },
            orderBy: { created_at: 'desc' }
        });

        // Map installments for backward compatibility with the frontend if needed
        const mappedOrders = orders.map(order => {
            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];
            return {
                ...order,
                payments: rows.filter(r => r.status === 'paid').map(r => ({
                    paymentType: r.month === 0 ? 'advance' : 'installment',
                    amount: r.amount || 0,
                    created_at: r.paid_at || order.created_at,
                    method: r.payment_method
                }))
            };
        });

        res.json({ success: true, data: mappedOrders });
    } catch (error) {
        console.error('getCustomerLedger error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getRecoveryReport
 */
const getRecoveryReport = async (req, res) => {
    const outletFilter = getOutletFilter(req);

    try {
        const orders = await prisma.order.findMany({
            where: {
                ...outletFilter,
                status: { notIn: ['Cancelled', 'Rejected'] }
            },
            include: {
                installment_ledger: true
            }
        });

        const recoveryList = orders.map(order => {
            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];
            const totalPaid = rows.filter(r => r.status === 'paid').reduce((acc, p) => acc + (p.amount || 0), 0);
            const balance = order.total_amount - totalPaid;
            return {
                order_id: order.id,
                order_ref: order.order_ref,
                customer: order.customer_name,
                phone: order.whatsapp_number,
                total_amount: order.total_amount,
                total_paid: totalPaid,
                balance
            };
        }).filter(item => item.balance > 0);

        res.json({ success: true, data: recoveryList });
    } catch (error) {
        console.error('getRecoveryReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getAllOutlets
 * Simple helper for admin selector
 */
const getAllOutlets = async (req, res) => {
    try {
        const outlets = await prisma.outlet.findMany({
            select: { id: true, name: true, city: true }
        });
        res.json({ success: true, data: outlets });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching outlets' });
    }
};

module.exports = {
    getDaybook,
    getStockSummary,
    getSalesReport,
    getProfitLoss,
    getCustomerLedger,
    getRecoveryReport,
    getAllOutlets
};
