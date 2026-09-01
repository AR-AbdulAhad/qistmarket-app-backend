const prisma = require('../../lib/prisma');
const { getOutletFilter } = require('../utils/outletFilter');
const { getNormalizedLedger } = require('../utils/ledgerUtils');

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
    const { startDate, endDate } = req.query;

    try {
        const inventory = await prisma.outletInventory.findMany({
            where: outletFilter
        });

        // Filter sold items by date if dates provided
        // We'd typically need the sale date, but currently outletInventory status just says "Sold"
        // Let's assume updated_at represents the sale date for "Sold" items
        const dateFilter = {};
        if (startDate) dateFilter.gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        }

        const summary = inventory.reduce((acc, item) => {
            let includeSold = true;
            if (item.status === 'Sold' && (dateFilter.gte || dateFilter.lte)) {
                const updatedDate = new Date(item.updated_at);
                if (dateFilter.gte && updatedDate < dateFilter.gte) includeSold = false;
                if (dateFilter.lte && updatedDate > dateFilter.lte) includeSold = false;
            }

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
            
            // Only count if it's in stock or it's sold within the date range (or no date filter)
            if (item.status === 'In Stock') {
                acc[key].total++;
                acc[key].inStock++;
                acc[key].valuation += item.purchase_price;
            } else if (item.status === 'Sold' && includeSold) {
                acc[key].total++;
                acc[key].sold++;
                acc[key].valuation += item.purchase_price; // Value of what we had/sold
            }
            
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
    const { startDate, endDate } = req.query;

    try {
        // Sales Report only shows delivered orders
        const where = { ...outletFilter, status: 'delivered' };

        if (startDate || endDate) {
            where.updated_at = {};
            if (startDate) where.updated_at.gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                where.updated_at.lte = end;
            }
        }

        const orders = await prisma.order.findMany({
            where,
            include: {
                installment_ledger: true,
                delivery: true,
                cash_in_hand: { orderBy: { created_at: 'desc' }, take: 1 }
            },
            orderBy: { updated_at: 'desc' }
        });

        // Resolve the ACTUAL delivered product by IMEI, not the suggested product_name
        // stored on the order at creation time — the outlet may hand over a different
        // physical unit than what was originally requested.
        const deliveryImeis = orders
            .map(o => o.cash_in_hand?.[0]?.imei_serial || o.delivery?.product_imei || o.imei_serial)
            .filter(Boolean);

        const deliveryInventories = deliveryImeis.length > 0
            ? await prisma.outletInventory.findMany({
                where: { imei_serial: { in: deliveryImeis } },
                select: { imei_serial: true, product_name: true }
            })
            : [];

        const deliveryInventoryMap = new Map();
        for (const inv of deliveryInventories) {
            if (inv.imei_serial) deliveryInventoryMap.set(inv.imei_serial, inv);
        }

        // Down payment (advance) is month 0 on the installment ledger. Read it
        // from the ledger's normalized advance row rather than the static
        // Order.advance_amount column, since the actually-paid amount can
        // diverge from the originally planned advance (partial payments,
        // manual ledger edits, etc).
        const ordersWithDownPayment = orders.map(o => {
            const rows = Array.isArray(o.installment_ledger?.ledger_rows) ? o.installment_ledger.ledger_rows : [];
            const { advance_payment, installment_ledger, summary: ledgerSummary } = getNormalizedLedger(rows);

            const imeiSerial = o.cash_in_hand?.[0]?.imei_serial || o.delivery?.product_imei || o.imei_serial;
            const invInfo = imeiSerial ? deliveryInventoryMap.get(imeiSerial) : null;
            const delivered_product_name = invInfo?.product_name || o.cash_in_hand?.[0]?.product_name || o.product_name || null;

            const down_payment_amount = advance_payment.paid ? advance_payment.amount : 0;

            // Sales value, tenure, and the monthly installment amount are read from the
            // ledger (the actually-agreed plan) rather than Order.total_amount/months/
            // monthly_amount, since those static columns hold the originally suggested
            // plan and can diverge from what was actually agreed at delivery (advance
            // overrides, plan changes, etc) — same reasoning as down_payment_amount above.
            const hasLedger = installment_ledger.length > 0;
            const sales_value = hasLedger ? ledgerSummary.grandTotalDue : o.total_amount;
            const tenure = hasLedger ? installment_ledger.length : o.months;
            const installment_amount = hasLedger ? (installment_ledger[0]?.dueAmount ?? o.monthly_amount) : o.monthly_amount;
            const balance = sales_value - down_payment_amount;

            return {
                ...o,
                product_name: delivered_product_name,
                suggested_product_name: o.product_name,
                down_payment_amount,
                down_payment_planned: advance_payment.amount,
                down_payment_paid: advance_payment.paid,
                down_payment_status: advance_payment.status,
                sales_value,
                tenure,
                installment_amount,
                balance
            };
        });

        // "Total Amount Received" must reflect cash actually collected WITHIN
        // the selected date range, not just paid-ever across each order's
        // whole ledger history. Filter each paid row by its own paid_at,
        // mirroring the convention already used in getDaybook above.
        const rangeStart = startDate ? new Date(startDate) : null;
        let rangeEnd = null;
        if (endDate) {
            rangeEnd = new Date(endDate);
            rangeEnd.setHours(23, 59, 59, 999);
        }

        const summary = {
            totalOrders: orders.length,
            totalGrossAmount: orders.reduce((acc, o) => acc + o.total_amount, 0),
            totalDownPaymentsReceived: ordersWithDownPayment.reduce((acc, o) => acc + o.down_payment_amount, 0),
            totalReceived: orders.reduce((acc, o) => {
                const rows = Array.isArray(o.installment_ledger?.ledger_rows) ? o.installment_ledger.ledger_rows : [];
                return acc + rows.filter(r => {
                    if (r.status !== 'paid') return false;
                    if (!rangeStart && !rangeEnd) return true;
                    if (!r.paid_at) return false;
                    const paidDate = new Date(r.paid_at);
                    if (rangeStart && paidDate < rangeStart) return false;
                    if (rangeEnd && paidDate > rangeEnd) return false;
                    return true;
                }).reduce((pAcc, p) => pAcc + (p.amount || 0), 0);
            }, 0)
        };

        res.json({ success: true, data: { summary, orders: ordersWithDownPayment } });
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

        // 1. Fetch Ledgers in the range (Actual cash inflow)
        const ledgers = await prisma.installmentLedger.findMany({
            where: {
                order: outletFilter,
            },
        });

        let totalRevenue = 0;
        for (const ledger of ledgers) {
            const rows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : [];
            for (const row of rows) {
                if (row.status === 'paid' && row.paid_at) {
                    const paidDate = new Date(row.paid_at);
                    if (paidDate >= dateFilter.gte && paidDate <= (dateFilter.lte || new Date())) {
                        totalRevenue += parseFloat(row.amount || row.dueAmount || 0);
                    }
                }
            }
        }

        // 2. Find Orders in the range for COGS (Only DELIVERED orders)
        const orders = await prisma.order.findMany({
            where: {
                ...outletFilter,
                updated_at: dateFilter, // Use updated_at for delivery date approximation
                is_delivered: true
            },
            select: {
                imei_serial: true
            }
        });
        
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

/**
 * getFinancialReport
 * Aggregates both Expense and VendorPayment models to show cash out-flow.
 */
const getFinancialReport = async (req, res) => {
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

        const expenses = await prisma.expenseVoucher.findMany({
            where: {
                ...outletFilter,
                ...(Object.keys(dateFilter).length > 0 && { date: dateFilter })
            },
            include: { items: true },
            orderBy: { date: 'desc' }
        });

        const vendorPayments = await prisma.vendorPayment.findMany({
            where: {
                ...outletFilter,
                ...(Object.keys(dateFilter).length > 0 && { created_at: dateFilter })
            },
            include: { vendor: true },
            orderBy: { created_at: 'desc' }
        });

        res.json({ success: true, data: { expenses, vendorPayments } });
    } catch (error) {
        console.error('getFinancialReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getInstallmentRecoveriesReport
 * Filters installment_ledger rows where status = paid yielding pure cash inflows.
 */
const getInstallmentRecoveriesReport = async (req, res) => {
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

        const ledgers = await prisma.installmentLedger.findMany({
            where: {
                order: { ...outletFilter, status: { notIn: ['Cancelled', 'Rejected'] } }
            },
            include: {
                order: { select: { order_ref: true, customer_name: true, whatsapp_number: true, id: true } }
            }
        });

        let recoveries = [];
        let totalRecovered = 0;

        for (const ledger of ledgers) {
            const rows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : [];
            for (const row of rows) {
                // month === 0 is the advance/down-payment row (see
                // ledgerUtils.js's normalizeLedger convention) — this report
                // is specifically monthly installment recoveries, so the
                // advance must be excluded even when it's been paid.
                if (row.month === 0) continue;
                if (row.status === 'paid' && row.paid_at) {
                    const paidDate = new Date(row.paid_at);
                    let include = true;
                    if (dateFilter.gte && paidDate < dateFilter.gte) include = false;
                    if (dateFilter.lte && paidDate > dateFilter.lte) include = false;

                    if (include) {
                        const amount = parseFloat(row.amount || row.dueAmount || 0);
                        totalRecovered += amount;
                        recoveries.push({
                            order_id: ledger.order.id,
                            order_ref: ledger.order.order_ref,
                            customer_name: ledger.order.customer_name,
                            whatsapp_number: ledger.order.whatsapp_number,
                            amount: amount,
                            month: row.month,
                            label: row.label || `Month ${row.month}`,
                            paid_at: row.paid_at,
                            payment_method: row.payment_method || 'Cash'
                        });
                    }
                }
            }
        }
        
        // Sort by paid_at descending
        recoveries.sort((a, b) => new Date(b.paid_at) - new Date(a.paid_at));

        res.json({ success: true, data: { recoveries, totalRecovered } });
    } catch (error) {
        console.error('getInstallmentRecoveriesReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getOfficerRecoveryReport
 * Performance of recovery officers assigned to the outlet.
 */
const getOfficerRecoveryReport = async (req, res) => {
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

        // We fetch all orders that have a recovery_officer_id and are in this outlet
        const orders = await prisma.order.findMany({
            where: {
                ...outletFilter,
                recovery_officer_id: { not: null },
                status: { notIn: ['Cancelled', 'Rejected'] }
            },
            include: {
                recovery_officer: { select: { id: true, full_name: true, phone: true } },
                installment_ledger: true
            }
        });

        const officerMap = {};

        for (const order of orders) {
            const officerId = order.recovery_officer_id;
            const officer = order.recovery_officer;
            if (!officerId || !officer) continue;

            if (!officerMap[officerId]) {
                officerMap[officerId] = {
                    officer_id: officerId,
                    officer_name: officer.full_name,
                    officer_phone: officer.phone,
                    assigned_orders: 0,
                    total_recovered: 0,
                    recoveries: []
                };
            }

            officerMap[officerId].assigned_orders += 1;

            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];
            for (const row of rows) {
                if (row.status === 'paid' && row.paid_at) {
                    const paidDate = new Date(row.paid_at);
                    let include = true;
                    if (dateFilter.gte && paidDate < dateFilter.gte) include = false;
                    if (dateFilter.lte && paidDate > dateFilter.lte) include = false;

                    if (include) {
                        const amount = parseFloat(row.amount || row.dueAmount || 0);
                        officerMap[officerId].total_recovered += amount;
                        officerMap[officerId].recoveries.push({
                            order_id: order.id,
                            order_ref: order.order_ref,
                            amount: amount,
                            paid_at: row.paid_at
                        });
                    }
                }
            }
        }

        res.json({ success: true, data: Object.values(officerMap) });
    } catch (error) {
        console.error('getOfficerRecoveryReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getInstallmentAnalytics
 * Aggregates advanced analytics for installment accounts (PTPs, locks, trends).
 */
const getInstallmentAnalytics = async (req, res) => {
    try {
        const outletId = req.user.outlet_id;
        if (!outletId) {
            return res.status(403).json({ success: false, message: 'Not an outlet user.' });
        }

        const outletFilter = { outlet_id: outletId };

        // 1. Total Installment Customers
        const activeOrders = await prisma.order.findMany({
            where: {
                outlet_id: outletId,
                months: { gt: 0 },
                status: { in: ['pending', 'in_progress', 'delivered'] }
            },
            select: { id: true, imei_serial: true }
        });
        const orderIds = activeOrders.map(o => o.id);

        // 2. Ledgers for these orders
        const ledgers = await prisma.installmentLedger.findMany({
            where: { order_id: { in: orderIds } }
        });

        let totalOnlineAmount = 0;
        let onlineCount = 0;
        let totalCashAmount = 0;
        let cashCount = 0;
        let totalOfficerAmount = 0;
        let officerCount = 0;

        const todayDate = new Date();
        todayDate.setHours(0, 0, 0, 0);
        const yesterdayDate = new Date(todayDate);
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);

        const firstDayOfThisMonth = new Date(todayDate.getFullYear(), todayDate.getMonth(), 1);
        const lastDayOfThisMonth = new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 0, 23, 59, 59, 999);
        
        let todayRecovered = 0;
        let yesterdayRecovered = 0;
        let lastMonthRecovered = 0; 
        const firstDayOfLastMonth = new Date(todayDate.getFullYear(), todayDate.getMonth() - 1, 1);
        const lastDayOfLastMonth = new Date(todayDate.getFullYear(), todayDate.getMonth(), 0, 23, 59, 59, 999);

        let expectedDueThisMonth = 0;
        let recoveredThisMonth = 0;

        let totalLockedBalance = 0;
        let lockedCount = 0;

        for (const ledger of ledgers) {
            const rows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : [];
            let ledgerRemainingBalance = 0;
            
            for (const row of rows) {
                const amount = parseFloat(row.amount || row.dueAmount || 0);

                if (row.status !== 'paid') {
                    ledgerRemainingBalance += amount;
                }

                if (row.dueDate) {
                    const due = new Date(row.dueDate);
                    if (due >= firstDayOfThisMonth && due <= lastDayOfThisMonth) {
                        expectedDueThisMonth += amount;
                    }
                }

                if (row.status === 'paid' && row.paid_at) {
                    const paidDate = new Date(row.paid_at);
                    const paidDateStart = new Date(paidDate);
                    paidDateStart.setHours(0,0,0,0);

                    if (paidDateStart.getTime() === todayDate.getTime()) todayRecovered += amount;
                    if (paidDateStart.getTime() === yesterdayDate.getTime()) yesterdayRecovered += amount;
                    if (paidDate >= firstDayOfLastMonth && paidDate <= lastDayOfLastMonth) lastMonthRecovered += amount;
                    if (paidDate >= firstDayOfThisMonth && paidDate <= lastDayOfThisMonth) recoveredThisMonth += amount;

                    if (row.method === 'online' || row.payment_method === 'online') {
                        totalOnlineAmount += amount;
                        onlineCount++;
                    } else {
                        totalCashAmount += amount;
                        cashCount++;
                    }

                    if (row.collected_by_role === 'recovery_officer' || row.collected_by) {
                        totalOfficerAmount += amount;
                        officerCount++;
                    }
                }
            }
            ledger.remainingBalance = ledgerRemainingBalance;
        }

        // 3. PTP and Device Locks from PayTriggerDevice
        const ptpDevices = await prisma.payTriggerDevice.findMany({
            where: { order_id: { in: orderIds } }
        });

        const ptpStats = { active: 0, broken: 0, fulfilled: 0, none: 0 };
        for (const device of ptpDevices) {
            const status = device.ptp_status || 'none';
            if (ptpStats[status] !== undefined) ptpStats[status]++;
            else ptpStats[status] = 1;

            if (device.lock_status === 'locked') {
                lockedCount++;
                const ledger = ledgers.find(l => l.order_id === device.order_id);
                if (ledger) {
                    totalLockedBalance += ledger.remainingBalance;
                }
            }
        }

        const avgLockedBalance = lockedCount > 0 ? (totalLockedBalance / lockedCount) : 0;
        const monthRecoveryRatio = expectedDueThisMonth > 0 ? ((recoveredThisMonth / expectedDueThisMonth) * 100) : 0;

        res.json({
            success: true,
            data: {
                totalCustomers: orderIds.length,
                paymentSplits: {
                    online: { count: onlineCount, amount: totalOnlineAmount },
                    cash: { count: cashCount, amount: totalCashAmount },
                    officer: { count: officerCount, amount: totalOfficerAmount }
                },
                ptpStats,
                devices: {
                    lockedCount,
                    totalLockedBalance,
                    avgLockedBalance
                },
                trends: {
                    today: todayRecovered,
                    yesterday: yesterdayRecovered,
                    lastMonth: lastMonthRecovered,
                    thisMonthExpected: expectedDueThisMonth,
                    thisMonthRecovered: recoveredThisMonth,
                    recoveryRatio: monthRecoveryRatio
                }
            }
        });

    } catch (error) {
        console.error('getInstallmentAnalytics error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getDaybook,
    getStockSummary,
    getSalesReport,
    getProfitLoss,
    getCustomerLedger,
    getRecoveryReport,
    getAllOutlets,
    getFinancialReport,
    getInstallmentRecoveriesReport,
    getOfficerRecoveryReport,
    getInstallmentAnalytics
};
