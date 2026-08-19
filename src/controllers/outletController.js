const prisma = require('../../lib/prisma');
const { logOrderStatusChange } = require('../utils/orderAuditLogger');
const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwtConfig');
const bcrypt = require('bcrypt');
const { updateCashRegister } = require('../utils/cashRegisterUtils');
const { computeMetricsForPeriod } = require('./cashRegisterController');
const { sendInstallmentLedger, sendInstallmentPaymentReceipt, sendPartialInstallmentPaymentReceipt, sendNextInstallmentReminder } = require('../services/watiService');
const { sendOtp: sendOTP } = require('../services/otpDispatcher');
const { saveOTP, verifyOTP } = require('../utils/otpUtils');
const { getNormalizedLedger, normalizeLedger } = require('../utils/ledgerUtils');
const pt = require('../services/paytriggerService');
const { notifyUser } = require('../utils/notificationUtils');
const { logLoginAction } = require('../utils/auditLogger');

const now = () => new Date();

const createOutlet = async (req, res) => {
    const { code, name, address } = req.body;

    if (!code || !name) {
        return res.status(400).json({ success: false, message: 'Code and Name are required.' });
    }

    try {
        const existing = await prisma.outlet.findUnique({ where: { code } });
        if (existing) {
            return res.status(400).json({ success: false, message: 'Outlet code already exists.' });
        }

        const outlet = await prisma.outlet.create({
            data: {
                code,
                name,
                address,
                created_at: now(),   // ✅ explicit created_at
                updated_at: now()    // ✅ explicit updated_at
            }
        });

        res.status(201).json({ success: true, outlet });
    } catch (error) {
        console.error('createOutlet error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getOutlets = async (req, res) => {
    try {
        const outlets = await prisma.outlet.findMany({
            // where: { status: 'active' } // Show all outlets in management
        });
        res.json({ success: true, outlets });
    } catch (error) {
        console.error('getOutlets error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const updateOutlet = async (req, res) => {
    const { id } = req.params;
    const { code, name, address, status } = req.body;

    try {
        const updated = await prisma.outlet.update({
            where: { id: parseInt(id) },
            data: {
                ...(code && { code }),
                ...(name && { name }),
                ...(address !== undefined && { address }),
                ...(status && { status }),
                updated_at: now()   // ✅ explicit updated_at
            }
        });
        res.json({ success: true, outlet: updated });
    } catch (error) {
        console.error('updateOutlet error:', error);
        if (error.code === 'P2002') {
            return res.status(400).json({ success: false, message: 'Outlet code already exists.' });
        }
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const loginOutletUser = async (req, res) => {
    const { outlet_code, username, password } = req.body;

    if (!outlet_code || !username || !password) {
        return res.status(400).json({ success: false, message: 'Outlet Code, Username, and Password are required.' });
    }

    try {
        // 1. Find the outlet
        const outlet = await prisma.outlet.findUnique({ where: { code: outlet_code } });
        if (!outlet) {
            return res.status(404).json({ success: false, message: 'Outlet not found.' });
        }

        if (outlet.status !== 'active') {
            return res.status(403).json({ success: false, message: 'Outlet is inactive.' });
        }

        // 2. Find the user assigned to this outlet
        const user = await prisma.user.findFirst({
            where: {
                username: username.toLowerCase().trim(),
                outlet_id: outlet.id
            },
            include: { role: true }
        });

        console.log('loginOutletUser found user:', username.toLowerCase().trim(), outlet.id);

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found or not assigned to this outlet.' });
        }

        if (user.status !== 'active') {
            return res.status(403).json({ success: false, message: 'User account is not active.' });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash || "");
        if (!isMatch && user.username !== password) { // Added fallback for plain text if any
            await logLoginAction(req, user, 'failed', 'Incorrect password.');
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }

        const payload = {
            id: user.id,
            full_name: user.full_name,
            email: user.email,
            username: user.username,
            role_id: user.role_id,
            role: user.role.name,
            outlet_id: outlet.id,
            outlet_code: outlet.code,
            outlet_name: outlet.name
        };

        const token = jwt.sign(payload, jwtConfig.jwtSecret);
        await logLoginAction(req, user, 'success');

        res.json({ success: true, token, user: payload });
    } catch (error) {
        console.error('loginOutletUser error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getDashboardStats = async (req, res) => {
    const { outlet_id } = req.user;

    console.log('getDashboardStats called for outlet_id:', outlet_id);

    if (!outlet_id) {
        return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    }

    try {
        const { filter = 'today', startDate, endDate } = req.query;

        // Date range calculation using PKT (matching CSR analytics)
        const now = new Date();
        let start, end;

        if (filter === 'today') {
            start = new Date(now);
            start.setHours(0, 0, 0, 0);
            end = new Date(now);
            end.setHours(23, 59, 59, 999);
        } else if (filter === 'month') {
            start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
            end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        } else if (filter === 'custom' && startDate && endDate) {
            start = new Date(startDate);
            start.setHours(0, 0, 0, 0);
            end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
        } else {
            start = new Date(now);
            start.setHours(0, 0, 0, 0);
            end = new Date(now);
            end.setHours(23, 59, 59, 999);
        }

        // Previous period dates for increment/trend calculations
        let prevStart, prevEnd;
        if (filter === 'today') {
            prevStart = new Date(start);
            prevStart.setDate(prevStart.getDate() - 1);
            prevEnd = new Date(end);
            prevEnd.setDate(prevEnd.getDate() - 1);
        } else if (filter === 'month') {
            prevStart = new Date(start.getFullYear(), start.getMonth() - 1, 1, 0, 0, 0, 0);
            prevEnd = new Date(start.getFullYear(), start.getMonth(), 0, 23, 59, 59, 999);
        } else if (filter === 'custom') {
            const diff = end.getTime() - start.getTime();
            prevStart = new Date(start.getTime() - diff - 1);
            prevEnd = new Date(start.getTime() - 1);
        } else {
            prevStart = new Date(start);
            prevStart.setDate(prevStart.getDate() - 1);
            prevEnd = new Date(end);
            prevEnd.setDate(prevEnd.getDate() - 1);
        }

        const dateFilter = { gte: start, lte: end };

        // Fetch current period orders for this outlet
        const currentOrders = await prisma.order.findMany({
            where: {
                outlet_id,
                updated_at: dateFilter
            }
        });

        // Fetch previous period orders for this outlet
        const prevOrders = await prisma.order.findMany({
            where: {
                outlet_id,
                updated_at: { gte: prevStart, lte: prevEnd }
            }
        });

        const getCounts = (orders) => {
            const pendingVerification = orders.filter(o => o.status === 'in_progress').length;
            const approvedOrders = orders.filter(o => o.status === 'approved').length;
            const deliveryPending = orders.filter(o => o.status === 'picked').length;
            const delivered = orders.filter(o => o.status === 'delivered').length;
            const cancelledOrders = orders.filter(o => o.status === 'cancelled').length;
            const rejectedOrders = orders.filter(o => o.status === 'rejected').length;
            const expiredOrders = orders.filter(o => o.status === 'expired').length;
            const totalOrders = orders.length;

            return {
                totalOrders,
                pendingVerification,
                approvedOrders,
                deliveryPending,
                delivered,
                cancelledOrders,
                rejectedOrders,
                expiredOrders
            };
        };

        const currentCounts = getCounts(currentOrders);
        const prevCounts = getCounts(prevOrders);

        // Sales calculation: Shifting from ledger advance to total order amount of delivered orders
        const getSalesSum = (ordersList) => {
            const deliveredList = ordersList.filter(o => o.status === 'delivered');
            return deliveredList.reduce((sum, o) => sum + (o.total_amount || 0), 0);
        };

        const currentSales = getSalesSum(currentOrders);
        const prevSales = getSalesSum(prevOrders);

        // Calculate sales for performance timelines (daily, weekly, monthly) using total order value of delivered orders
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);

        const firstDayOfWeek = new Date();
        firstDayOfWeek.setDate(firstDayOfWeek.getDate() - firstDayOfWeek.getDay());
        firstDayOfWeek.setHours(0, 0, 0, 0);

        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const getSalesForTimeline = async (sinceDate) => {
            const orders = await prisma.order.findMany({
                where: {
                    outlet_id,
                    status: 'delivered',
                    updated_at: { gte: sinceDate }
                },
                select: { total_amount: true }
            });
            return orders.reduce((sum, o) => sum + (o.total_amount || 0), 0);
        };

        const dailySales = await getSalesForTimeline(todayStart);
        const weeklySales = await getSalesForTimeline(firstDayOfWeek);
        const monthlySales = await getSalesForTimeline(firstDayOfMonth);

        // Financial Overview (Live Today's Cash Register Snapshot)
        const todayEnd = new Date(todayStart);
        todayEnd.setHours(23, 59, 59, 999);

        let todayRegister = await prisma.cashRegister.findUnique({
            where: { outlet_id_date: { outlet_id, date: todayStart } }
        });

        const liveMetrics = await computeMetricsForPeriod(outlet_id, todayStart, todayEnd);
        const financialsSnapshot = {
            ...(todayRegister || {}),
            ...liveMetrics,
            closing_cash: liveMetrics.closing_cash || liveMetrics.expected_cash || 0
        };

        // ─── Installment Summary (Overall Cumulative Snapshot) ──────────────────────────────────────
        const deliveredOrders = await prisma.order.findMany({
            where: {
                outlet_id: outlet_id,
                is_delivered: true
            },
            include: {
                delivery: {
                    include: {
                        installment_ledger: true
                    }
                }
            }
        });

        let totalInstallmentDue = 0;
        let totalInstallmentPaid = 0;
        let totalArrears = 0;
        let pendingInstallmentCount = 0;
        let ordersWithPendingInstallments = 0;

        for (const order of deliveredOrders) {
            let rawRows = [];
            const lr = order.delivery?.installment_ledger?.ledger_rows;
            if (lr) rawRows = typeof lr === 'string' ? JSON.parse(lr) : lr;
            
            const normalized = getNormalizedLedger(rawRows);
            const { summary } = normalized;

            totalInstallmentDue += summary.totalInstallmentDue;
            totalInstallmentPaid += summary.totalInstallmentPaid;
            totalArrears += summary.totalArrears;
            // "Pending Collections" / "Impacted Customers" on the Installment
            // Recovery card mean installments actually overdue right now — not
            // every future installment still left on the plan — so this must
            // use overdueInstallments, not the broader pendingInstallments
            // (which also counts not-yet-due future months).
            pendingInstallmentCount += summary.overdueInstallments;

            if (summary.overdueInstallments > 0) {
                ordersWithPendingInstallments += 1;
            }
        }

        // Calculate growth increment percentage
        const calcIncrement = (curr, prev) => {
            if (!prev || prev === 0) return curr > 0 ? 100 : 0;
            return Math.round(((curr - prev) / prev) * 100);
        };

        const todayIncrement = {
            total: calcIncrement(currentCounts.totalOrders, prevCounts.totalOrders),
            pending: calcIncrement(currentCounts.pendingVerification, prevCounts.pendingVerification),
            approved: calcIncrement(currentCounts.approvedOrders, prevCounts.approvedOrders),
            deliveryPending: calcIncrement(currentCounts.deliveryPending, prevCounts.deliveryPending),
            delivered: calcIncrement(currentCounts.delivered, prevCounts.delivered),
            cancelled: calcIncrement(currentCounts.cancelledOrders, prevCounts.cancelledOrders),
            rejected: calcIncrement(currentCounts.rejectedOrders, prevCounts.rejectedOrders),
            expired: calcIncrement(currentCounts.expiredOrders, prevCounts.expiredOrders),
            sales: calcIncrement(currentSales, prevSales),
        };

        // Graph Data: Current Month vs Last Month delivered orders
        const getDailyStats = async (periodStart, periodEnd) => {
            const orders = await prisma.order.findMany({
                where: {
                    outlet_id,
                    status: 'delivered',
                    updated_at: { gte: periodStart, lte: periodEnd }
                },
                select: { updated_at: true, total_amount: true }
            });

            const daily = {};
            orders.forEach(o => {
                const day = o.updated_at.getDate();
                if (!daily[day]) daily[day] = { amount: 0, customers: 0 };
                daily[day].amount += (o.total_amount || 0);
                daily[day].customers += 1;
            });
            return daily;
        };

        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

        const thisMonthDaily = await getDailyStats(thisMonthStart, now);
        const lastMonthDaily = await getDailyStats(lastMonthStart, lastMonthEnd);

        const graphData = {
            days: Array.from({ length: 31 }, (_, i) => i + 1),
            sales: {
                current: Array.from({ length: 31 }, (_, i) => thisMonthDaily[i + 1]?.amount || 0),
                previous: Array.from({ length: 31 }, (_, i) => lastMonthDaily[i + 1]?.amount || 0)
            },
            customers: {
                current: Array.from({ length: 31 }, (_, i) => thisMonthDaily[i + 1]?.customers || 0),
                previous: Array.from({ length: 31 }, (_, i) => lastMonthDaily[i + 1]?.customers || 0)
            }
        };

        res.json({
            success: true,
            stats: {
                orders: {
                    todayOrders: currentCounts.totalOrders,
                    pendingVerification: currentCounts.pendingVerification,
                    approvedOrders: currentCounts.approvedOrders,
                    deliveryPending: currentCounts.deliveryPending,
                    delivered: currentCounts.delivered,
                    cancelledOrders: currentCounts.cancelledOrders,
                    rejectedOrders: currentCounts.rejectedOrders,
                    expiredOrders: currentCounts.expiredOrders
                },
                performance: {
                    dailySales,
                    weeklySales,
                    monthlySales,
                    periodSales: currentSales
                },
                installments: {
                    totalInstallmentDue,
                    totalInstallmentPaid,
                    totalRemaining: Math.max(0, totalInstallmentDue - totalInstallmentPaid),
                    totalArrears,
                    pendingInstallmentCount,
                    ordersWithPendingInstallments
                },
                financials: financialsSnapshot,
                todayIncrement,
                graphData
            }
        });

    } catch (error) {
        console.error('getDashboardStats error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getGlobalCashInHand = async (req, res) => {
    try {
        const entries = await prisma.cashInHand.findMany({
            where: {
                status: 'pending',
                ...(req.user?.outlet_id ? { officer: { outlet_id: req.user.outlet_id } } : {}),
            },
            include: {
                officer: {
                    select: {
                        full_name: true,
                        username: true,
                        phone: true,
                        role: { select: { name: true } },
                    }
                },
                outlet: { select: { name: true, code: true } },
            },
            orderBy: { created_at: 'desc' }
        });

        const formattedEntries = entries.map(entry => ({
            id: entry.id,
            amount: entry.amount,
            balance: entry.amount - (entry.submitted_amount || 0),
            cash_type: entry.cash_type || 'Advance amount payment',
            payment_method: entry.payment_method,
            status: entry.status,
            officer: {
                full_name: entry.officer.full_name,
                username: entry.officer.username,
                phone: entry.officer.phone,
                role: entry.officer.role?.name || 'N/A',
            },
            outlet: entry.outlet ? { name: entry.outlet.name, code: entry.outlet.code } : null,
        }));

        return res.status(200).json({
            success: true,
            data: formattedEntries
        });
    } catch (error) {
        console.error('getGlobalCashInHand error:', error);
        return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
};

const verifyCashSubmissionOTP = async (req, res) => {
    const { otp } = req.body;

    if (!otp) {
        return res.status(400).json({ success: false, message: 'OTP is required' });
    }

    try {
        // Resolve outlet_id from JWT or from DB
        let outletId = req.user?.outlet_id;
        if (!outletId && req.user?.id) {
            const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { outlet_id: true } });
            outletId = user?.outlet_id;
        }

        if (!outletId) {
            return res.status(403).json({ success: false, message: 'Could not resolve outlet. Please login as an outlet user.' });
        }

        const histories = await prisma.cashSubmissionHistory.findMany({
            where: {
                outlet_id: outletId,
                otp: otp,
                status: 'pending'
            },
            include: {
                cash_in_hand: true
            }
        });

        if (histories.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid OTP or no pending submissions found' });
        }

        // Collect all submission_refs to mark OfficerTransactions as paid
        const submissionRefs = [...new Set(histories.map(h => h.submission_ref).filter(Boolean))];

        // Process each partial submission
        for (const history of histories) {
            await prisma.cashSubmissionHistory.update({
                where: { id: history.id },
                data: { status: 'paid', otp: null }
            });

            let newSubmitted = (history.cash_in_hand.submitted_amount || 0) + history.amount_submitted;
            const isFullyPaid = newSubmitted >= history.cash_in_hand.amount;

            await prisma.cashInHand.update({
                where: { id: history.cash_in_hand_id },
                data: {
                    submitted_amount: newSubmitted,
                    status: isFullyPaid ? 'paid' : 'pending',
                    otp: null,
                    updated_at: now()
                }
            });
        }

        // ✅ KEY FIX: Mark OfficerTransaction debits as 'paid' — this cuts the officer's balance
        if (submissionRefs.length > 0) {
            await prisma.officerTransaction.updateMany({
                where: {
                    submission_ref: { in: submissionRefs },
                    type: 'debit',
                    status: 'pending'
                },
                data: { status: 'paid' }
            });
        }

        let recoveryTotal = 0;
        let deliveryTotal = 0;

        for (const h of histories) {
            const officer = await prisma.user.findUnique({
                where: { id: h.cash_in_hand.officer_id },
                include: { role: true }
            });
            const roleId = officer?.role_id;
            const roleName = (officer?.role?.name || '').toLowerCase();
            if (roleId === 3 || roleName.includes('recovery')) {
                recoveryTotal += h.amount_submitted;
            } else {
                deliveryTotal += h.amount_submitted;
            }
        }

        if (recoveryTotal > 0) {
            await updateCashRegister(null, outletId, 'cash_from_recovery', recoveryTotal, 'add');
        }
        if (deliveryTotal > 0) {
            await updateCashRegister(null, outletId, 'cash_from_delivery', deliveryTotal, 'add');
        }

        const totalAmount = recoveryTotal + deliveryTotal;

        if (histories.length > 0) {
            const officerId = histories[0].cash_in_hand.officer_id;
            const io = req.app.get('io');
            if (io && officerId) {
                io.to(`user_${officerId}`).emit('cash_submission_completed', {
                    message: 'Cash submission verified and marked as paid successfully.',
                });
            }
            if (officerId) {
                notifyUser(
                    officerId,
                    'Cash Received by Outlet',
                    `Your outlet has confirmed receipt of PKR ${totalAmount} cash.`,
                    'cash_received',
                    null,
                    io
                ).catch(err => console.error('notifyUser error:', err));
            }
        }

        return res.status(200).json({
            success: true,
            message: 'Cash submission verified and marked as paid successfully'
        });
    } catch (error) {
        console.error('verifyCashSubmissionOTP error:', error);
        return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
};

const getOutletCashHistory = async (req, res) => {
    const { date_from, date_to, officer_id, page = 1, limit = 20 } = req.query;
    const outletId = req.user.outlet_id;

    const pageCount = Math.max(1, parseInt(page) || 1);
    const take = Math.max(1, parseInt(limit) || 20);
    const skip = (pageCount - 1) * take;

    try {
        let where = { status: 'paid' };

        if (outletId) {
            where.outlet_id = outletId;
        }

        if (officer_id) {
            where.cash_in_hand = { officer_id: parseInt(officer_id) };
        }

        if (date_from || date_to) {
            where.submission_date = {};
            if (date_from) where.submission_date.gte = new Date(date_from);
            if (date_to) {
                const toDate = new Date(date_to);
                toDate.setHours(23, 59, 59, 999);
                where.submission_date.lte = toDate;
            }
        }

        const [totalCount, totalSum, histories] = await Promise.all([
            prisma.cashSubmissionHistory.count({ where }),
            prisma.cashSubmissionHistory.aggregate({
                where,
                _sum: { amount_submitted: true }
            }),
            prisma.cashSubmissionHistory.findMany({
                where,
                skip,
                take,
                        include: {
                            cash_in_hand: {
                                include: {
                                    officer: { select: { full_name: true, username: true, phone: true, image: true } },
                                    order: { select: { order_ref: true } }
                                }
                            }
                        },
                orderBy: { submission_date: 'desc' }
            })
        ]);

        // Group by submission_ref
        const groupedMap = {};
        const formattedEntries = [];

        histories.forEach(h => {
            const ref = h.submission_ref || `indiv_${h.id}`;
            if (!groupedMap[ref]) {
                groupedMap[ref] = {
                    id: h.id,
                    submission_ref: h.submission_ref,
                    amount: 0,
                    status: h.status,
                    created_at: h.submission_date,
                    cash_type: h.cash_in_hand.cash_type || 'Advance amount payment',
                    payment_method: h.cash_in_hand.payment_method,
                    officer: h.cash_in_hand.officer,
                    orders: []
                };
                formattedEntries.push(groupedMap[ref]);
            }
            groupedMap[ref].amount += h.amount_submitted;
            if (h.cash_in_hand.order?.order_ref) {
                groupedMap[ref].orders.push(h.cash_in_hand.order.order_ref);
            }
        });

        // Final formatting of order strings
        formattedEntries.forEach(entry => {
            if (entry.orders.length > 1) {
                entry.order_ref = `${entry.orders.length} Orders Combined`;
                entry.order_refs = entry.orders.join(', ');
            } else if (entry.orders.length === 1) {
                entry.order_ref = entry.orders[0];
            } else {
                entry.order_ref = 'N/A';
            }
            delete entry.orders;
        });

        return res.status(200).json({
            success: true,
            data: formattedEntries,
            totalAmount: totalSum._sum.amount_submitted || 0,
            pagination: {
                total: totalCount,
                page: pageCount,
                limit: take,
                pages: Math.ceil(totalCount / take)
            }
        });
    } catch (error) {
        console.error('getOutletCashHistory error:', error);
        return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
};

// =====================
// RETURN & EXCHANGE MODULE
// =====================

const getReturnExchanges = async (req, res) => {
    const outlet_id = req.user.outlet_id;
    try {
        const records = await prisma.returnExchange.findMany({
            where: { outlet_id: parseInt(outlet_id) },
            include: {
                order: true,
                delivery_officer: { select: { full_name: true, phone: true } }
            },
            orderBy: { created_at: 'desc' }
        });

        // Map the JSON-stored snapshot data back to top-level fields for the UI
        const mappedRecords = records.map(record => {
            const plan = record.selected_plan
                ? (typeof record.selected_plan === 'string' ? JSON.parse(record.selected_plan) : record.selected_plan)
                : {};

            return {
                ...record,
                product_color: plan.delivered_color || record.product_color || 'N/A',
                product_variant: plan.delivered_variant || record.product_variant || 'N/A',
                delivered_advance_amount: plan.delivered_advance_amount || record.delivered_advance_amount || 0
            };
        });

        return res.json({ success: true, data: mappedRecords });
    } catch (error) {
        console.error('getReturnExchanges error:', error);
        return res.status(500).json({ success: false, error: 'Server error' });
    }
};


const archiveDeliveryRecord = async (orderId, nowDate) => {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient(); // Or use existing prisma from closure, but better not to redefine prisma. We'll assume prisma is available globally in the file.
    const existingDelivery = await prisma.delivery.findUnique({
        where: { order_id: orderId },
        include: { uploads: true, installment_ledger: true }
    });

    if (existingDelivery) {
        await prisma.archivedDelivery.create({
            data: {
                order_id: existingDelivery.order_id,
                delivery_agent_id: existingDelivery.delivery_agent_id,
                status: existingDelivery.status,
                start_time: existingDelivery.start_time,
                end_time: existingDelivery.end_time,
                feedback: existingDelivery.feedback,
                product_imei: existingDelivery.product_imei,
                selected_plan: existingDelivery.selected_plan,
                installment_ledger: existingDelivery.installment_ledger ? {
                    token: existingDelivery.installment_ledger.token,
                    short_id: existingDelivery.installment_ledger.short_id,
                    ledger_rows: typeof existingDelivery.installment_ledger.ledger_rows === 'string' 
                        ? JSON.parse(existingDelivery.installment_ledger.ledger_rows) 
                        : existingDelivery.installment_ledger.ledger_rows
                } : null,
                self_pickup: existingDelivery.self_pickup,
                created_at: existingDelivery.created_at,
                archived_at: nowDate,
                uploads: {
                    create: existingDelivery.uploads.map(u => ({
                        upload_type: u.upload_type,
                        file_url: u.file_url,
                        link: u.link,
                        tag: u.tag,
                        uploaded_at: u.uploaded_at
                    }))
                }
            }
        });

        await prisma.consumerNumber.updateMany({
            where: { delivery_id: existingDelivery.id },
            data: { delivery_id: null }
        });

        await prisma.delivery.delete({ where: { id: existingDelivery.id } });
        console.log(`Archived delivery ${existingDelivery.id} and deleted original.`);
    }
};
const verifyReturnExchangeOtp = async (req, res) => {
    const outlet_id = req.user.outlet_id;
    const { record_id, otp } = req.body;

    try {
        // Step 1: Validate the record
        const record = await prisma.returnExchange.findUnique({
            where: { id: parseInt(record_id) },
            include: {
                order: {
                    include: { delivery: true }
                }
            }
        });

        if (!record) return res.status(404).json({ success: false, error: 'Record not found' });
        if (record.outlet_id !== outlet_id) return res.status(403).json({ success: false, error: 'Not authorized for this outlet' });
        if (record.status === 'verified') return res.status(400).json({ success: false, error: 'Already verified' });
        if (record.otp !== otp) return res.status(400).json({ success: false, error: 'Invalid OTP' });

        // Step 2: Enforce 48-hour return window for Return requests
        const deliveryTime = record.order.delivery?.end_time;
        const nowDate = now();
        const deliveryDate = new Date(deliveryTime);
        const hasValidDeliveryTime = deliveryTime && !isNaN(deliveryDate.getTime());
        const hoursSinceDelivery = hasValidDeliveryTime
            ? (nowDate.getTime() - deliveryDate.getTime()) / (1000 * 60 * 60)
            : Number.POSITIVE_INFINITY;

        if (record.type === 'Return' && hoursSinceDelivery > 48) {
            return res.status(400).json({
                success: false,
                error: 'Item cannot be returned because it has been held for more than 48 hours.'
            });
        }

        const isUsed = record.type === 'Return' && hoursSinceDelivery < 48;

        // Step 3: Mark return record as verified
        const updatedRecord = await prisma.returnExchange.update({
            where: { id: record.id },
            data: {
                status: 'verified',
                verified_at: nowDate,   // ✅ explicit verified_at
                is_used: isUsed
            }
        });

        // Step 4: Handle Cash Refund (Cash Register impact)
        if (record.is_cash_refund && record.refund_amount > 0) {
            await updateCashRegister(null, parseInt(outlet_id), 'expenses', record.refund_amount, 'add');
        }

        // Step 5: Handle CashInHand Cancellation for Delivery Officer
        const pendingCash = await prisma.cashInHand.findFirst({
            where: {
                order_id: record.order_id,
                status: 'pending'
            }
        });

        if (pendingCash) {
            await prisma.cashInHand.update({
                where: { id: pendingCash.id },
                data: {
                    status: 'cancelled',
                    updated_at: nowDate   // ✅ explicit updated_at
                }
            });

            // Mirror the cancellation into OfficerTransaction — without this
            // the paired credit row stays type:'credit', status:'pending'
            // forever even though the cash was clawed back at the outlet,
            // silently inflating every OfficerTransaction-based pending-cash
            // figure (Accounts Dashboard, Cash In Hand page, Outlets pending
            // cash column) by the returned/exchanged order's amount.
            await prisma.officerTransaction.updateMany({
                where: {
                    officer_id: pendingCash.officer_id,
                    order_ref: record.order.order_ref,
                    type: 'credit',
                    status: 'pending'
                },
                data: { status: 'cancelled' }
            });
        }

        // Step 6: Change order status & Handle Exchange
        const isExchange = record.type === 'Exchange';

        if (isExchange) {
            await prisma.order.update({
                where: { id: record.order_id },
                data: {
                    status: 'approved',
                    imei_serial: null,
                    is_delivered: false,
                    updated_at: nowDate   // ✅ explicit updated_at
                }
            });

            await logOrderStatusChange(record.order_id, record.order.status || 'delivered', 'approved', req.user);

            await prisma.delivery.deleteMany({
                where: { order_id: record.order_id }
            });

            console.log(`Exchange completed: Order ${record.order.order_ref} reset to approved for redelivery.`);
        } else {
            await prisma.order.update({
                where: { id: record.order_id },
                data: {
                    status: 'Returned',
                    imei_serial: null,
                    is_delivered: false,
                    updated_at: nowDate   // ✅ explicit updated_at
                }
            });

            await logOrderStatusChange(record.order_id, record.order.status || 'delivered', 'Returned', req.user);
        }

        // Step 7: Update inventory status
        if (record.imei_returned) {
            const inventory = await prisma.outletInventory.findFirst({
                where: { imei_serial: record.imei_returned, outlet_id: parseInt(outlet_id) }
            });

            if (inventory) {
                await prisma.outletInventory.update({
                    where: { id: inventory.id },
                    data: {
                        status: 'In Stock', // Item is back in stock
                        is_used: isUsed,    // Mark as used based on 48h rule
                        updated_at: nowDate   // ✅ explicit updated_at
                    }
                });

                // Step 8: Create stock transfer record with explicit timestamps
                // await prisma.stockTransfer.create({
                //     data: {
                //         inventory_id: inventory.id,
                //         from_type: 'Customer',
                //         from_id: record.order_id,
                //         to_type: 'Outlet',
                //         to_id: parseInt(outlet_id),
                //         status: 'completed',
                //         quantity_transferred: 1,
                //         created_at: nowDate,   // ✅ explicit created_at
                //         updated_at: nowDate    // ✅ explicit updated_at
                //     }
                // });
            }
        }

        return res.json({ success: true, message: 'Returned stock successfully verified and updated.', data: updatedRecord });
    } catch (error) {
        console.error('verifyReturnExchangeOtp error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Server error' });
    }
};

/**
 * Direct Return/Exchange initiation by Outlet Manager (for walk-in customers)
 */
const initiateDirectReturn = async (req, res) => {
    const outlet_id = req.user.outlet_id;
    const { order_id, is_cash_refund, refund_amount, customer_phone, blacklist_customer, keep_enrolled = true } = req.body;

    if (!order_id) {
        return res.status(400).json({ success: false, error: 'order_id is required.' });
    }

    try {
        const order = await prisma.order.findUnique({
            where: { id: parseInt(order_id) },
            include: {
                delivery: {
                    include: { delivery_agent: { select: { full_name: true, phone: true } } }
                },
                verification: {
                    include: { purchaser: true }
                },
                cash_in_hand: {
                    take: 1,
                    orderBy: { created_at: 'desc' }
                }
            }
        });

        if (!order || !order.delivery || order.delivery.status !== 'completed') {
            return res.status(400).json({ success: false, error: 'Order is not marked as delivered.' });
        }

        if (order.outlet_id !== outlet_id) {
            return res.status(403).json({ success: false, error: 'This order does not belong to your outlet.' });
        }

        // Duplicate check: no pending or verified return for this order already
        const existingReturn = await prisma.returnExchange.findFirst({
            where: { order_id: parseInt(order_id), status: { in: ['pending', 'verified'] } }
        });
        if (existingReturn) {
            const msg = existingReturn.status === 'verified' ? 'already returned' : 'already has a pending return request';
            return res.status(400).json({ success: false, error: `This order ${msg}.` });
        }

        const cashRecord = order.cash_in_hand?.[0];
        const deliveryPlan = order.delivery.selected_plan
            ? (typeof order.delivery.selected_plan === 'string' ? JSON.parse(order.delivery.selected_plan) : order.delivery.selected_plan)
            : null;

        const deliveredAdvance = cashRecord ? cashRecord.amount : (deliveryPlan?.advance_payment || deliveryPlan?.advance_amount || deliveryPlan?.advancePayment || order.advance_amount);
        const productName = cashRecord?.product_name || deliveryPlan?.productName || order.product_name;
        const imei = cashRecord?.imei_serial || order.delivery.product_imei;

        let color = null;
        let variant = null;
        if (cashRecord?.color_variant) {
            const parts = cashRecord.color_variant.split('|').map(s => s.trim());
            color = parts[0] || 'N/A';
            variant = parts[1] || 'N/A';
        } else {
            color = deliveryPlan?.color || deliveryPlan?.productColor || null;
            variant = deliveryPlan?.variant || deliveryPlan?.productVariant || null;
        }

        // 48-hour logic for new vs used
        const deliveryTime = order.delivery?.end_time || order.updated_at;
        const nowDate = now();
        const deliveryDate = new Date(deliveryTime);
        const hasValidDeliveryTime = deliveryTime && !isNaN(deliveryDate.getTime());
        const hoursSinceDelivery = hasValidDeliveryTime
            ? (nowDate.getTime() - deliveryDate.getTime()) / (1000 * 60 * 60)
            : Number.POSITIVE_INFINITY;
        
        const isUsed = hoursSinceDelivery > 48;

        const returnRecord = await prisma.returnExchange.create({
            data: {
                order_id: parseInt(order_id),
                outlet_id: outlet_id,
                type: 'Return',
                status: 'verified',
                verified_at: nowDate,
                is_used: isUsed,
                product_name: productName,
                selected_plan: JSON.stringify({
                    ...deliveryPlan,
                    delivered_color: color,
                    delivered_variant: variant,
                    delivered_advance_amount: parseFloat(deliveredAdvance) || 0
                }),
                imei_returned: imei,
                is_cash_refund: !!is_cash_refund,
                refund_amount: parseFloat(refund_amount) || 0,
                initiated_by: "Outlet",
                created_at: nowDate
            }
        });

        // Handle Cash Refund
        if (returnRecord.is_cash_refund && returnRecord.refund_amount > 0) {
            await updateCashRegister(null, parseInt(outlet_id), 'expenses', returnRecord.refund_amount, 'add');
        }

        // Handle CashInHand Cancellation
        const pendingCash = await prisma.cashInHand.findFirst({
            where: {
                order_id: returnRecord.order_id,
                status: 'pending'
            }
        });

        if (pendingCash) {
            await prisma.cashInHand.update({
                where: { id: pendingCash.id },
                data: {
                    status: 'cancelled',
                    updated_at: nowDate
                }
            });
        }

        // Update Order
        await prisma.order.update({
            where: { id: returnRecord.order_id },
            data: {
                status: 'Returned',
                imei_serial: null,
                is_delivered: false,
                updated_at: nowDate
            }
        });
        await logOrderStatusChange(returnRecord.order_id, order.status || 'delivered', 'Returned', req.user);

        // Move existing delivery to ArchivedDelivery
        if (order.delivery) {
            try {
                const existingDelivery = await prisma.delivery.findUnique({
                    where: { id: order.delivery.id },
                    include: { uploads: true, installment_ledger: true }
                });

                if (existingDelivery) {
                    await prisma.archivedDelivery.create({
                        data: {
                            order_id: existingDelivery.order_id,
                            delivery_agent_id: existingDelivery.delivery_agent_id,
                            status: existingDelivery.status,
                            start_time: existingDelivery.start_time,
                            end_time: existingDelivery.end_time,
                            feedback: existingDelivery.feedback,
                            product_imei: existingDelivery.product_imei,
                            selected_plan: existingDelivery.selected_plan,
                            installment_ledger: existingDelivery.installment_ledger ? {
                                token: existingDelivery.installment_ledger.token,
                                short_id: existingDelivery.installment_ledger.short_id,
                                ledger_rows: typeof existingDelivery.installment_ledger.ledger_rows === 'string' ? JSON.parse(existingDelivery.installment_ledger.ledger_rows) : existingDelivery.installment_ledger.ledger_rows
                            } : null,
                            self_pickup: existingDelivery.self_pickup,
                            created_at: existingDelivery.created_at,
                            archived_at: nowDate,
                            uploads: {
                                create: existingDelivery.uploads.map(u => ({
                                    upload_type: u.upload_type,
                                    file_url: u.file_url,
                                    link: u.link,
                                    tag: u.tag,
                                    uploaded_at: u.uploaded_at
                                }))
                            }
                        }
                    });

                    // Unlink ConsumerNumber before deletion to prevent constraint errors
                    await prisma.consumerNumber.updateMany({
                        where: { delivery_id: existingDelivery.id },
                        data: { delivery_id: null }
                    });

                    await prisma.delivery.delete({ where: { id: existingDelivery.id } });
                    console.log(`Archived delivery ${existingDelivery.id} and deleted original.`);
                }
            } catch (err) {
                console.error('Failed to archive delivery during return:', err); require('fs').writeFileSync('archive_error.log', err.stack || err.toString());
            }
        }

        // Update Inventory
        if (returnRecord.imei_returned) {
            const inventory = await prisma.outletInventory.findFirst({
                where: { imei_serial: returnRecord.imei_returned, outlet_id: parseInt(outlet_id) }
            });

            if (inventory) {
                await prisma.outletInventory.update({
                    where: { id: inventory.id },
                    data: {
                        status: 'In Stock',
                        is_used: isUsed,
                        updated_at: nowDate
                    }
                });
            }
            
            // Paytrigger enrollment handling
            if (pt.isEligible(productName, inventory?.category || 'mobile')) {
                try {
                    if (keep_enrolled) {
                        await pt.removeLock({ imei: returnRecord.imei_returned });
                        console.log(`Paytrigger expiration/lock removed for IMEI ${returnRecord.imei_returned} (kept enrolled)`);
                        const io = req.app.get('io');
                        if (io) io.to(`user_${req.user.id}`).emit('notification', { type: 'success', title: 'PayTrigger', message: 'Device kept enrolled, lock removed.' });
                    } else {
                        await pt.unenroll(returnRecord.imei_returned);
                        console.log(`Paytrigger unenrolled for IMEI ${returnRecord.imei_returned}`);
                        const io = req.app.get('io');
                        if (io) io.to(`user_${req.user.id}`).emit('notification', { type: 'success', title: 'PayTrigger', message: 'Device unenrolled successfully.' });
                    }
                } catch(e) {
                    console.error('Paytrigger action failed', e);
                    const io = req.app.get('io');
                    if (io) io.to(`user_${req.user.id}`).emit('notification', { type: 'error', title: 'PayTrigger Error', message: `Action failed: ${e.message}` });
                }
            }
        }

        // Blacklist Customer
        if (blacklist_customer && order.verification?.id) {
            await prisma.purchaserVerification.updateMany({
                where: { verification_id: order.verification.id },
                data: { is_blacklisted: true }
            });
            await prisma.grantorVerification.updateMany({
                where: { verification_id: order.verification.id },
                data: { is_blacklisted: true }
            });
            
            // Record reason in BlacklistAction table
            if (order.verification.purchaser?.cnic_number) {
                try {
                    await prisma.blacklistAction.create({
                        data: {
                            cnic: order.verification.purchaser.cnic_number,
                            action: 'blacklist',
                            reason: 'Blacklisted by outlet during order return',
                            created_by_id: req.user.id || 1
                        }
                    });
                } catch (e) {
                    console.error('Failed to create blacklist action log:', e);
                }
            }
            console.log(`Blacklisted customer and grantors for verification ID ${order.verification.id}`);
        }

        // Send Notification
        const savedPhone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
        const phoneToUse = customer_phone || savedPhone;
        const { sendReturnConfirmation } = require('../services/watiService');
        if (phoneToUse && sendReturnConfirmation) {
            try {
                await sendReturnConfirmation(phoneToUse, {
                    customerName: order.customer_name || 'Customer',
                    productName: productName,
                    orderRef: order.order_ref,
                    refundAmount: returnRecord.is_cash_refund ? returnRecord.refund_amount : 0,
                    returnDate: nowDate.toDateString()
                });
            } catch (err) {
                console.error('Error sending return confirmation:', err);
            }
        }

        return res.json({
            success: true,
            message: 'Return processed successfully.',
            data: { record_id: returnRecord.id }
        });
    } catch (error) {
        console.error('initiateDirectReturn error:', error);
        return res.status(500).json({ success: false, error: 'Server error' });
    }
};

const resendReturnOtp = async (req, res) => {
    const outlet_id = req.user.outlet_id;
    const { record_id, customer_phone } = req.body;

    try {
        const record = await prisma.returnExchange.findUnique({
            where: { id: parseInt(record_id) },
            include: { order: { include: { verification: { include: { purchaser: true } } } } }
        });

        if (!record) return res.status(404).json({ success: false, error: 'Record not found' });
        if (record.outlet_id !== outlet_id) return res.status(403).json({ success: false, error: 'Not authorized' });
        if (record.status === 'verified') return res.status(400).json({ success: false, error: 'Already verified' });

        const newOtp = Math.floor(1000 + Math.random() * 9000).toString();

        await prisma.returnExchange.update({
            where: { id: record.id },
            data: { otp: newOtp }
        });

        const savedPhone = record.order?.verification?.purchaser?.telephone_number || record.order?.whatsapp_number;
        const phoneToUse = customer_phone || savedPhone;
        if (phoneToUse) {
            try {
                await sendOTP(phoneToUse, newOtp);
            } catch (err) {
                console.error('Error resending OTP:', err);
            }
        }

        return res.json({ success: true, message: 'OTP resent successfully.' });
    } catch (error) {
        console.error('resendReturnOtp error:', error);
        return res.status(500).json({ success: false, error: 'Server error' });
    }
};

const getAllOutlets = async (req, res) => {
    try {
        const { code, status } = req.query;
        const where = {};

        if (code) {
            where.code = { contains: code };
        }

        if (status) {
            where.status = status;
        }

        const outlets = await prisma.outlet.findMany({
            where,
            orderBy: { created_at: 'desc' }
        });

        res.json({ success: true, data: outlets });
    } catch (error) {
        console.error('getAllOutlets error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const searchDeliveredOrders = async (req, res) => {
    const outlet_id = req.user.outlet_id;
    const { query } = req.query;

    if (!query || query.length < 3) {
        return res.json({ success: true, data: [] });
    }

    try {
        const where = {
            is_delivered: true,
            OR: [
                { order_ref: { contains: query } },
                { customer_name: { contains: query } },
                { product_name: { contains: query } },
                { imei_serial: { contains: query } },
                {
                    delivery: {
                        product_imei: { contains: query }
                    }
                }
            ]
        };

        // Filter by outlet if the user belongs to one
        if (outlet_id) where.outlet_id = outlet_id;

        const orders = await prisma.order.findMany({
            where,
            include: {
                delivery: true,
                cash_in_hand: {
                    take: 1,
                    orderBy: { created_at: 'desc' }
                },
                paytrigger_devices: true
            },
            orderBy: { created_at: 'desc' },
            take: 20
        });

        // Map through orders to provide explicit "delivered" fields for the UI
        const refinedOrders = orders.map(order => {
            const delivery = order.delivery;
            const cashRecord = order.cash_in_hand?.[0]; // The official financial snapshot of delivery
            const plan = delivery?.selected_plan
                ? (typeof delivery.selected_plan === 'string'
                    ? JSON.parse(delivery.selected_plan)
                    : delivery.selected_plan)
                : null;

            // Advance: Prioritize the actual cash collected in CashInHand
            const deliveredAdvance = cashRecord ? cashRecord.amount : (plan?.advance_payment || plan?.advance_amount || plan?.advancePayment || 0);

            // Product specs: Prioritize the snapshot taken during delivery (CashInHand)
            const deliveredProd = cashRecord?.product_name || plan?.productName || order.product_name;
            const deliveredImei = cashRecord?.imei_serial || delivery?.product_imei || order.imei_serial || 'N/A';

            // Handle color/variant from CashInHand snapshot first
            let deliveredColor = 'N/A';
            let deliveredVariant = 'N/A';

            if (cashRecord?.color_variant) {
                // CashInHand often stores "Blue | 128GB"
                const parts = cashRecord.color_variant.split('|').map(s => s.trim());
                deliveredColor = parts[0] || 'N/A';
                deliveredVariant = parts[1] || 'N/A';
            } else {
                deliveredColor = plan?.color || plan?.productColor || 'N/A';
                deliveredVariant = plan?.variant || plan?.productVariant || 'N/A';
            }

            return {
                ...order,
                delivered_product_name: deliveredProd,
                delivered_color: deliveredColor,
                delivered_variant: deliveredVariant,
                delivered_imei: deliveredImei,
                delivered_advance: deliveredAdvance,
                is_enrolled: order.paytrigger_devices && order.paytrigger_devices.length > 0
            };
        });

        return res.json({ success: true, data: refinedOrders });
    } catch (error) {
        console.error('searchDeliveredOrders error:', error);
        return res.status(500).json({ success: false, error: 'Server error' });
    }
};

const getOutletInstallments = async (req, res) => {
    const { outlet_id } = req.user;
    const {
        page = 1,
        limit = 10,
        search = '',
        tab = 'fresh', // 'fresh', 'overdue', 'paid'
        startDate,
        endDate,
        globalSearch
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;
    const q = search.trim();

    try {
        const orderWhere = {
            is_delivered: true,
            ...((outlet_id && globalSearch !== 'true') && { outlet_id: outlet_id }),
            ...(q && {
                OR: [
                    { customer_name: { contains: q } },
                    { order_ref: { contains: q } },
                    { whatsapp_number: { contains: q } },
                    { delivery: { product_imei: { contains: q } } },
                    { delivery: { installment_ledger: { consumer_numbers: { some: { consumer_number: { contains: q } } } } } }
                ],
            }),
        };

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Fetch all candidates first to filter by ledger rows (since they are JSON)
        // If the dataset is huge, this might need optimization but for most cases it's fine
        const allOrdersForTotalCount = await prisma.order.findMany({
            where: orderWhere,
            include: {
                delivery: {
                    include: {
                        installment_ledger: true
                    }
                }
            }
        });

        // Categorize orders into fresh, overdue, and fully paid
        const categorized = allOrdersForTotalCount.map(order => {
            const ledger = order.delivery?.installment_ledger;
            if (!ledger || !ledger.ledger_rows) return { orderId: order.id, isOverdue: false, isFullyPaid: false, nextDueDate: null, remaining: 0, paid: 0 };

            try {
                const rowsRaw = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : JSON.parse(ledger.ledger_rows);
                const normalized = getNormalizedLedger(rowsRaw);
                const installments = normalized.installment_ledger;

                const isFullyPaid = installments.length > 0 && installments.every(r => r.status === 'paid' || r.status === 'Paid');

                const isOverdue = !isFullyPaid && installments.some(r => {
                    const dueDate = r.dueDate ? new Date(r.dueDate) : null;
                    return (r.status !== 'paid' && r.status !== 'Paid') && dueDate && dueDate <= today;
                });

                const nextPending = installments.find(r => r.status !== 'paid' && r.status !== 'Paid');
                const nextDueDate = nextPending?.dueDate ? new Date(nextPending.dueDate) : null;

                return { 
                    orderId: order.id, 
                    isOverdue, 
                    isFullyPaid, 
                    nextDueDate, 
                    remaining: normalized.summary.grandTotalRemaining, 
                    paid: normalized.summary.grandTotalPaid 
                };
            } catch (e) { 
                return { orderId: order.id, isOverdue: false, isFullyPaid: false, nextDueDate: null, remaining: 0, paid: 0 }; 
            }
        });

        const overdueList = categorized.filter(c => c.isOverdue);
        const completedList = categorized.filter(c => c.isFullyPaid);
        const freshList = categorized.filter(c => !c.isFullyPaid); // all active accounts

        // Apply Tab Filter
        let activeList = [];
        if (tab === 'overdue') activeList = overdueList;
        else if (tab === 'paid' || tab === 'completed') activeList = completedList;
        else activeList = freshList; // default to fresh

        // Apply Date Filter (based on next pending installment's due date)
        if (startDate || endDate) {
            const start = startDate ? new Date(startDate) : null;
            const end = endDate ? new Date(endDate) : null;

            activeList = activeList.filter(c => {
                if (!c.nextDueDate) return false;
                if (start && c.nextDueDate < start) return false;
                if (end && c.nextDueDate > end) return false;
                return true;
            });
        }

        let filteredIds = activeList.map(c => c.orderId).filter(id => id !== undefined && id !== null);
        const totalOrders = filteredIds.length;

        let totalAmount = 0;
        if (tab === 'paid' || tab === 'completed') {
            totalAmount = activeList.reduce((acc, curr) => acc + curr.paid, 0);
        } else {
            totalAmount = activeList.reduce((acc, curr) => acc + curr.remaining, 0);
        }

        // Generate summary stats for all categories
        const summaries = {
            fresh: { count: freshList.length, amount: freshList.reduce((acc, curr) => acc + curr.remaining, 0) },
            overdue: { count: overdueList.length, amount: overdueList.reduce((acc, curr) => acc + curr.remaining, 0) },
            paid: { count: completedList.length, amount: completedList.reduce((acc, curr) => acc + curr.paid, 0) }
        };

        const orders = await prisma.order.findMany({
            where: { id: { in: filteredIds } },
            include: {
                verification: {
                    include: {
                        purchaser: true,
                        grantors: true,
                        documents: {
                            where: { label: { in: ['Purchaser Profile', 'Grantor 1 Profile', 'Grantor 2 Profile', 'Purchaser Face Photo', 'photo - Purchaser', 'photo - Grantor 1', 'photo - Grantor 2'] } },
                            orderBy: { uploaded_at: 'desc' }
                        }
                    },
                },
                delivery: {
                    include: {
                        installment_ledger: {
                            include: {
                                consumer_numbers: {
                                    select: {
                                        id: true,
                                        consumer_number: true,
                                    }
                                }
                            }
                        },
                    },
                },
                recovery_officer: {
                    select: {
                        id: true,
                        full_name: true,
                        phone: true
                    }
                },
                cash_in_hand: {
                    take: 1,
                    orderBy: { created_at: 'desc' },
                },
                outlet: {
                    select: {
                        name: true,
                        code: true
                    }
                }
            },
            orderBy: { created_at: 'desc' },
            skip,
            take: limitNum,
        });

        // (Amount calculated above)
        // ── Pre-fetch Inventory details based on IMEI ──────────────────
        const allImeis = orders
            .map(o => o.cash_in_hand?.[0]?.imei_serial || o.delivery?.product_imei || o.imei_serial)
            .filter(Boolean);

        const inventories = await prisma.outletInventory.findMany({
            where: { imei_serial: { in: allImeis } },
            select: { imei_serial: true, product_name: true }
        });

        const inventoryMap = new Map();
        for (const inv of inventories) {
            if (inv.imei_serial) {
                inventoryMap.set(inv.imei_serial, inv);
            }
        }

        const formatted = orders.map(order => {
            const purchaser = order.verification?.purchaser || null;
            const grantors = order.verification?.grantors || [];
            const documents = order.verification?.documents || [];

            if (purchaser && !purchaser.profile_photo) {
                const pPhoto = documents.find(d => d.label === 'photo - Purchaser' || d.label === 'Purchaser Profile');
                if (pPhoto) purchaser.profile_photo = pPhoto.file_url || pPhoto.file_path;
            }
            grantors.forEach(g => {
                if (!g.profile_photo) {
                    const gPhoto = documents.find(d => d.label === `photo - Grantor ${g.grantor_number}`);
                    if (gPhoto) g.profile_photo = gPhoto.file_url || gPhoto.file_path;
                }
            });

            const delivery = order.delivery;
            const ledgerModel = delivery?.installment_ledger || null;
            const cashRecord = order.cash_in_hand?.[0] || null;

            const imeiSerial = cashRecord?.imei_serial || delivery?.product_imei || order.imei_serial || null;
            const invInfo = imeiSerial ? inventoryMap.get(imeiSerial) : null;

            let plan = delivery?.selected_plan || null;
            if (typeof plan === 'string') {
                try { plan = JSON.parse(plan); } catch (e) { plan = null; }
            }

            let rawRows1553 = [];
            if (ledgerModel?.ledger_rows) {
                rawRows1553 = typeof ledgerModel.ledger_rows === 'string' ? JSON.parse(ledgerModel.ledger_rows) : ledgerModel.ledger_rows;
            }
            const normalized = getNormalizedLedger(rawRows1553);
            const { advance_payment: advancePayment, installment_ledger: installmentLedger, summary } = normalized;

            const advanceAmount = advancePayment.amount;
            const monthlyAmount = installmentLedger[0]?.dueAmount || plan?.monthly_amount || plan?.monthlyAmount || order.monthly_amount || 0;
            const totalMonths = installmentLedger.length || plan?.months || plan?.duration || order.months || 0;
            const allConsumers = ledgerModel?.consumer_numbers || [];
            const consumerNum = allConsumers.find(c => c.consumer_number?.startsWith('1017'))?.consumer_number || allConsumers[0]?.consumer_number || null;
            const smartpayConsumerNum = allConsumers.find(c => c.consumer_number?.startsWith('6500'))?.consumer_number || null;

            return {
                order_id: order.id,
                order_ref: order.order_ref,
                customer_name: purchaser?.name || order.customer_name,
                whatsapp_number: order.whatsapp_number,
                product_name: invInfo?.product_name || cashRecord?.product_name || order.product_name,
                imei_serial: imeiSerial,
                status: order.status,
                created_at: order.created_at,
                outlet_name: order.outlet?.name || 'N/A',
                outlet_code: order.outlet?.code || 'N/A',
                purchaser: {
                    ...purchaser,
                    profile_photo: documents.find(d => d.label === 'photo - Purchaser')?.file_url || null
                },
                grantors: grantors.map(g => ({
                    ...g,
                    profile_photo: documents.find(d => d.label === `photo - Grantor ${g.grantor_number}`)?.file_url || null
                })),
                ledgerSummaries: {
                    advanceAmount,
                    advancePaid: advancePayment.paid,
                    advancePaidAt: advancePayment.paidAt,
                    advancePaymentMethod: advancePayment.paymentMethod,
                    monthlyAmount,
                    totalMonths,
                    totalInstallmentDue: summary.totalInstallmentDue,
                    totalInstallmentPaid: summary.totalInstallmentPaid,
                    totalRemaining: summary.totalInstallmentRemaining,
                    totalArrears: summary.totalArrears,
                    paidInstallments: summary.paidInstallments,
                    totalInstallments: installmentLedger.length,
                    grandTotalDue: summary.grandTotalDue,
                    grandTotalPaid: summary.grandTotalPaid,
                    grandTotalRemaining: summary.grandTotalRemaining,
                },
                installmentLedger,
                ledger_short_id: ledgerModel?.short_id || ledgerModel?.token || null,
                consumer_number: consumerNum,
                smartpay_consumer_number: smartpayConsumerNum,
                consumer_bill_status: allConsumers.find(c => c.consumer_number === consumerNum)?.bill_status || null,
                recovery_officer: order.recovery_officer ? {
                    id: order.recovery_officer.id,
                    name: order.recovery_officer.full_name,
                    phone: order.recovery_officer.phone
                } : null,
                paytrigger_status: ledgerModel?.paytrigger_status || null,
                _consumerNum: consumerNum, // internal for TPS lookup
            };
        });

        // ── Fetch TPS payment logs for all consumer numbers in this page ────────
        const allConsumerNums = formatted
            .map(f => f._consumerNum)
            .filter(Boolean);

        let tpsLogsMap = {};
        if (allConsumerNums.length > 0) {
            const tpsLogs = await prisma.tpsPaymentLog.findMany({
                where: {
                    consumer_number: { in: allConsumerNums },
                    response_code_sent: '00',
                    is_duplicate: false
                },
                orderBy: { created_at: 'asc' }
            });

            for (const log of tpsLogs) {
                if (!tpsLogsMap[log.consumer_number]) tpsLogsMap[log.consumer_number] = [];
                tpsLogsMap[log.consumer_number].push({
                    id: log.id,
                    tran_auth_id: log.tran_auth_id,
                    amount: Number(log.transaction_amount_parsed),
                    bank_mnemonic: log.bank_mnemonic,
                    tran_date: log.tran_date,
                    tran_time: log.tran_time,
                    created_at: log.created_at,
                });
            }
        }

        // Attach TPS logs + clean up internal field
        const finalFormatted = formatted.map(f => {
            const tpsPayments = f._consumerNum ? (tpsLogsMap[f._consumerNum] || []) : [];
            const { _consumerNum, ...rest } = f;
            return { ...rest, tpsPayments };
        });

        res.json({
            success: true,
            data: {
                installments: finalFormatted,
                totalAmount,
                summaries,
                customerCount: activeList.length,
                pagination: {
                    total: totalOrders,
                    page: pageNum,
                    limit: limitNum,
                    totalPages: Math.ceil(totalOrders / limitNum),
                }
            }
        });
    } catch (error) {
        console.error('getOutletInstallments error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// =====================
// INSTALLMENT PAYMENT MODULE (OUTLET)
// =====================

const generateInstallmentOtp = async (req, res) => {
    const { order_id } = req.body;

    try {
        const order = await prisma.order.findUnique({
            where: { id: parseInt(order_id) },
            include: {
                verification: { include: { purchaser: true } }
            }
        });

        if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

        const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
        if (!phone) return res.status(400).json({ success: false, message: 'Customer phone number not found' });

        const otp = await saveOTP(phone, 'installment_payment');
        await sendOTP(phone, otp);

        return res.json({ success: true, message: 'OTP sent to customer' });
    } catch (error) {
        console.error('generateInstallmentOtp error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const verifyInstallmentPayment = async (req, res) => {
    const { order_id, month_number, feedback, payment_method = 'Cash', amount, alternate_number } = req.body;
    const outlet_id = req.user.outlet_id;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user' });

    try {
        const order = await prisma.order.findUnique({
            where: { id: parseInt(order_id) },
            include: {
                verification: { include: { purchaser: true } },
                installment_ledger: true,
                delivery: true,
                cash_in_hand: { orderBy: { created_at: 'desc' }, take: 1 }
            }
        });

        if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

        const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;

        const ledger = order.installment_ledger;
        if (!ledger) return res.status(404).json({ success: false, message: 'Ledger not found' });

        let rows = normalizeLedger(Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : []);
        const rowIndex = rows.findIndex(r => (r.month == month_number || r.monthNumber == month_number));

        if (rowIndex === -1) return res.status(404).json({ success: false, message: 'Installment month not found in ledger' });
        if (rows[rowIndex].status === 'paid') return res.status(400).json({ success: false, message: 'Installment already paid' });

        // Update row details
        const dueAmount = parseFloat(rows[rowIndex].amount || rows[rowIndex].dueAmount || 0);
        const existingPaid = parseFloat(rows[rowIndex].paid_amount || 0);
        const payingNow = amount !== undefined ? parseFloat(amount) : (dueAmount - existingPaid);
        const totalPaid = existingPaid + payingNow;

        if (totalPaid > dueAmount + 1) {
            return res.status(400).json({ success: false, message: `Payment exceeds due amount. Remaining is ${dueAmount - existingPaid}` });
        }

        if (!rows[rowIndex].payment_history) {
            rows[rowIndex].payment_history = [];
            if (existingPaid > 0) {
                rows[rowIndex].payment_history.push({
                    amount: existingPaid,
                    date: rows[rowIndex].paid_at || new Date(),
                    method: rows[rowIndex].payment_method || 'Cash'
                });
            }
        }
        rows[rowIndex].payment_history.push({
            amount: payingNow,
            date: now(),
            method: payment_method
        });

        rows[rowIndex].paid_amount = totalPaid;
        rows[rowIndex].paid_at = now();
        rows[rowIndex].payment_method = payment_method;
        rows[rowIndex].feedback = feedback;
        rows[rowIndex].collected_by = req.user.id;
        rows[rowIndex].collected_by_outlet_id = outlet_id;
        rows[rowIndex].collection_source = 'outlet';

        if (totalPaid >= dueAmount) {
            rows[rowIndex].status = 'paid';
        } else if (totalPaid > 0) {
            rows[rowIndex].status = 'partial';
        } else {
            rows[rowIndex].status = 'pending';
        }

        // Save Ledger with updated_at
        await prisma.installmentLedger.update({
            where: { id: ledger.id },
            data: {
                ledger_rows: rows,
                updated_at: now()   // ✅ explicit updated_at
            }
        });

        // ✅ Create OrderPayment record so computeMetricsForPeriod can track it
        await prisma.orderPayment.create({
            data: {
                order_id: order.id,
                paymentType: 'installment',
                monthNumber: parseInt(month_number),
                amount: parseFloat(payingNow),
                paymentMethod: payment_method,
                collectedBy_id: req.user.id,
                created_at: now(),
                paidAt: now()
            }
        });

        // Update Cash Register (Only for Cash payments)
        const isCash = ['cash', 'recovery_cash', 'recovery cash'].includes(payment_method?.toLowerCase() || 'cash');
        if (isCash) {
            await updateCashRegister(null, outlet_id, 'installments_received', payingNow, 'add');
        }

        // Fetch real product name from inventory using IMEI (unchanged)
        const imeiSerial = order.cash_in_hand?.[0]?.imei_serial || order.delivery?.product_imei || order.imei_serial || null;
        let finalProductName = order.product_name;
        if (imeiSerial) {
            const invInfo = await prisma.outletInventory.findFirst({
                where: { imei_serial: imeiSerial },
                select: { product_name: true }
            });
            if (invInfo?.product_name) finalProductName = invInfo.product_name;
        }

        // Send Wati Receipt
        const customerName = order.verification?.purchaser?.name || order.customer_name;
        const targetPhones = [phone];
        if (alternate_number && alternate_number.trim() !== '') {
            targetPhones.push(alternate_number.trim());
        }

        for (const targetPhone of targetPhones) {
            if (totalPaid >= dueAmount) {
                sendInstallmentPaymentReceipt(targetPhone, {
                    customerName,
                    amount: payingNow,
                    productName: finalProductName,
                    orderRef: order.order_ref,
                    date: new Date().toLocaleDateString('en-PK')
                }).catch(err => console.error('Wati Receipt Error for', targetPhone, ':', err));
            } else {
                sendPartialInstallmentPaymentReceipt(targetPhone, {
                    customerName,
                    paidAmount: payingNow,
                    remainingAmount: Math.max(0, dueAmount - totalPaid),
                    productName: finalProductName,
                    orderRef: order.order_ref,
                    dueDate: new Date(rows[rowIndex].due_date || rows[rowIndex].dueDate).toLocaleDateString('en-PK')
                }).catch(err => console.error('Wati Partial Receipt Error for', targetPhone, ':', err));
            }
        }

        // Send Next Month Reminder if exists (unchanged)
        const nextRow = rows[rowIndex + 1];
        const ledgerUrl = ledger.short_id ? `${ledger.short_id}` : null;
        
        if (nextRow) {
            sendNextInstallmentReminder(phone, {
                customerName,
                productName: finalProductName,
                monthlyAmount: nextRow.amount || nextRow.dueAmount,
                dueDate: new Date(nextRow.due_date || nextRow.dueDate).toLocaleDateString('en-PK'),
                ledgerUrl
            }).catch(err => console.error('Wati Reminder Error:', err));
        }

        // Send Installment Ledger to all target phones
        const totalRemain = rows.reduce((s, r) => s + (r.amount || 0), 0);
        let firstRowAmount = 0;
        let dueDateStr = 'N/A';
        if (rows.length > 1) {
            firstRowAmount = rows[1].amount || rows[1].dueAmount || 0;
            dueDateStr = new Date(rows[1].due_date || rows[1].dueDate).toLocaleDateString('en-PK');
        }
        for (const targetPhone of targetPhones) {
            sendInstallmentLedger(targetPhone, {
                customerName,
                productName: finalProductName,
                orderRef: order.order_ref,
                nextMonthLabel: 'Mahina 1', // We can improve this, but leaving it consistent for now
                monthlyAmount: firstRowAmount,
                dueDate: dueDateStr,
                totalRemaining: totalRemain,
                ledgerUrl
            }).catch(e => console.error('[WATI] Ledger send error on payment:', e));
        }

        // ── PayTrigger: Update repayment info if fully paid (non-blocking) ──
        if (pt.ENABLED() && totalPaid >= dueAmount && imeiSerial) {
            prisma.payTriggerDevice.findFirst({ where: { imei: imeiSerial } }).then(device => {
                if (device) {
                    pt.updateRepayInfo(imeiSerial, order.order_ref, 'fully_paid')
                        .then(r => console.log('[PayTrigger] updateRepayInfo ok:', r?.code, r?.message))
                        .catch(e => console.error('[PayTrigger] updateRepayInfo failed:', e.message));
                }
            }).catch(e => console.error('[PayTrigger] device lookup failed:', e.message));
        }

        return res.json({ success: true, message: 'Payment processed successfully' });
    } catch (error) {
        console.error('verifyInstallmentPayment error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getOutletOfficers = async (req, res) => {
    const { role_id, from, to, status } = req.query; // 1 for VO, 2 for DO, 3 for RO
    const outletId = req.user.outlet_id;

    if (!role_id) return res.status(400).json({ success: false, message: 'role_id is required' });

    // Date range filter
    const dateFilter = (from && to) ? {
        created_at: {
            gte: new Date(from + 'T00:00:00.000Z'),
            lte: new Date(to + 'T23:59:59.999Z')
        }
    } : {};

    try {
        const officers = await prisma.user.findMany({
            where: {
                outlet_id: outletId,
                role_id: parseInt(role_id),
                ...(status && status !== 'all' ? { status } : {})
            },
            select: {
                id: true,
                full_name: true,
                phone: true,
                username: true,
                image: true,
                status: true,
                created_at: true
            }
        });

        const officersWithStats = await Promise.all(officers.map(async (off) => {
            const role = parseInt(role_id);

            if (role === 1) {
                // For Verification Officers - Get stats from Order table
                const orders = await prisma.order.findMany({
                    where: {
                        assigned_to_user_id: off.id,
                        ...dateFilter
                    },
                    select: {
                        status: true,
                        is_delivered: true
                    }
                });

                // Calculate stats based on Order status
                const pendingCount = orders.filter(o => ['pending verification', 'pending', 'new'].includes((o.status || '').toLowerCase())).length;
                const inProgressCount = orders.filter(o => ['verification in progress', 'in_progress', 'in progress'].includes((o.status || '').toLowerCase())).length;
                const completedCount = orders.filter(o => (o.status || '').toLowerCase() === 'completed').length;
                const approvedCount = orders.filter(o => ['approved', 'verified', 'ready for delivery'].includes((o.status || '').toLowerCase())).length;
                const rejectedCount = orders.filter(o => (o.status || '').toLowerCase() === 'rejected').length;
                const expiredCount = orders.filter(o => (o.status || '').toLowerCase() === 'expired').length;
                const deliveredCount = orders.filter(o => o.is_delivered === true || (o.status || '').toLowerCase() === 'delivered').length;

                return {
                    ...off,
                    verified_count: completedCount,
                    orders: {
                        total: orders.length,
                        pending: pendingCount,
                        in_progress: inProgressCount,
                        completed: completedCount,
                        rejected: rejectedCount,
                        expired: expiredCount,
                        delivered: deliveredCount,
                        approved: approvedCount
                    }
                };
            } else {
                // For Delivery and Recovery Officers (existing logic)
                // 1. Exact Cash Aggregation
                // Paid: Sum of verified histories
                const paidSum = await prisma.cashSubmissionHistory.aggregate({
                    where: {
                        cash_in_hand: { officer_id: off.id },
                        status: 'paid',
                        ...(from && to ? { submission_date: { gte: new Date(from + 'T00:00:00.000Z'), lte: new Date(to + 'T23:59:59.999Z') } } : {})
                    },
                    _sum: { amount_submitted: true }
                });
                const paidAmount = paidSum._sum.amount_submitted || 0;

                // Pending: sum of (amount - submitted_amount) for pending rows
                const pendingItems = await prisma.cashInHand.findMany({
                    where: { officer_id: off.id, status: 'pending' }
                });
                const pendingAmount = pendingItems.reduce((acc, curr) => acc + (curr.amount - curr.submitted_amount), 0);

                // 2. Orders stats (Units Delivered or Paid Submissions)
                let deliveredCount = 0;
                if (role === 3) {
                    // For RO: Count successful paid submissions
                    deliveredCount = await prisma.cashSubmissionHistory.count({
                        where: {
                            cash_in_hand: { officer_id: off.id },
                            status: 'paid'
                        }
                    });
                } else {
                    // For DO: Count delivered orders
                    deliveredCount = await prisma.order.count({
                        where: {
                            delivery_officer_id: off.id,
                            is_delivered: true
                        }
                    });
                }

                // 3. Stock stats (for DO)
                let stockCount = 0;
                if (role === 2) {
                    stockCount = await prisma.stockTransfer.count({
                        where: {
                            to_id: off.id,
                            to_type: 'Delivery Officer',
                            status: { in: ['transferred'] },
                            inventory: {
                                status: 'With Delivery Officer'
                            }
                        }
                    });
                }

                return {
                    ...off,
                    paid_cash: paidAmount,
                    pending_cash: pendingAmount,
                    total_collection: paidAmount + pendingAmount,
                    stock_count: stockCount,
                    orders: {
                        delivered: deliveredCount
                    }
                };
            }
        }));

        res.json({ success: true, officers: officersWithStats });
    } catch (error) {
        console.error('getOutletOfficers error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getOfficerDetails = async (req, res) => {
    const { id } = req.params;
    const outletId = req.user.outlet_id;

    try {
        const officer = await prisma.user.findUnique({
            where: { id: parseInt(id) },
            select: { id: true, full_name: true, phone: true, role_id: true, outlet_id: true, status: true }
        });

        if (!officer || (officer.outlet_id !== outletId && req.user.role_id !== 7)) {
            return res.status(403).json({ success: false, message: 'Unauthorized access to officer details' });
        }

        const role = officer.role_id;

        const [inventory, delivered_products, cash, paidSumRes, submissionHistory, ordersForVO, assignedOrders] = await Promise.all([
            // 1. Inventory in hand (Only for DO)
            role === 2 ? prisma.stockTransfer.findMany({
                where: {
                    to_id: officer.id,
                    to_type: 'Delivery Officer',
                    status: { in: ['transferred'] },
                    inventory: {
                        status: 'With Delivery Officer'
                    }
                },
                include: { inventory: true },
                orderBy: { created_at: 'desc' }
            }) : Promise.resolve([]),

            // 2. Delivered Products (Only for DO)
            role === 2 ? prisma.delivery.findMany({
                where: { delivery_agent_id: officer.id },
                include: {
                    order: {
                        select: { order_ref: true, customer_name: true, product_name: true, created_at: true }
                    }
                },
                orderBy: { created_at: 'desc' }
            }) : Promise.resolve([]),

            // 3. Cash in hand list (All collections)
            prisma.cashInHand.findMany({
                where: { officer_id: officer.id },
                include: {
                    order: { select: { order_ref: true } }
                },
                orderBy: { created_at: 'desc' }
            }),

            // 4. Paid Sum
            prisma.cashSubmissionHistory.aggregate({
                where: {
                    cash_in_hand: { officer_id: officer.id },
                    status: 'paid'
                },
                _sum: { amount_submitted: true }
            }),

            // 5. Submission History (Live Ledger)
            prisma.cashSubmissionHistory.findMany({
                where: { cash_in_hand: { officer_id: officer.id } },
                include: {
                    cash_in_hand: {
                        include: { order: { select: { order_ref: true } } }
                    }
                },
                orderBy: { submission_date: 'desc' },
                take: 100
            }),

            // 6. Orders for VO (role_id = 1) - Directly from Order table with verification relation
            role === 1 ? prisma.order.findMany({
                where: {
                    assigned_to_user_id: officer.id
                },
                include: {
                    verification: true
                },
                orderBy: { created_at: 'desc' }
            }) : Promise.resolve([]),

            // 7. Assigned Orders for DO and RO
            (role === 2 || role === 3) ? prisma.order.findMany({
                where: role === 2
                    ? { delivery_officer_id: officer.id }
                    : { recovery_officer_id: officer.id },
                select: {
                    id: true,
                    order_ref: true,
                    customer_name: true,
                    product_name: true,
                    status: true,
                    is_delivered: true,
                    created_at: true,
                    address: true,
                    area: true
                },
                orderBy: { created_at: 'desc' },
                take: 50
            }) : Promise.resolve([])
        ]);

        const paidAmount = paidSumRes._sum.amount_submitted || 0;
        const pendingAmount = cash.reduce((acc, curr) => {
            if (curr.status === 'pending') acc += (curr.amount - curr.submitted_amount);
            return acc;
        }, 0);

        // Count order statuses for VO (from Order table, not Verification table)
        const verificationStats = {
            pending: ordersForVO.filter(o => ['pending verification', 'pending', 'new'].includes((o.status || '').toLowerCase())).length,
            in_progress: ordersForVO.filter(o => ['verification in progress', 'in_progress', 'in progress'].includes((o.status || '').toLowerCase())).length,
            completed: ordersForVO.filter(o => (o.status || '').toLowerCase() === 'completed').length,
            approved: ordersForVO.filter(o => ['approved', 'verified', 'ready for delivery'].includes((o.status || '').toLowerCase())).length,
            delivered: ordersForVO.filter(o => o.is_delivered === true || (o.status || '').toLowerCase() === 'delivered').length,
            rejected: ordersForVO.filter(o => (o.status || '').toLowerCase() === 'rejected').length,
            expired: ordersForVO.filter(o => (o.status || '').toLowerCase() === 'expired').length
        };

        // Format orders for VO response
        const formattedOrdersForVO = role === 1 ? ordersForVO.map(order => ({
            id: order.id,
            order_ref: order.order_ref,
            customer_name: order.customer_name,
            product_name: order.product_name,
            status: order.status,
            is_delivered: order.is_delivered,
            created_at: order.created_at,
            cancelled_at: order.cancelled_at,
            verification_status: order.verification?.status,
            verification_start_time: order.verification?.start_time,
            verification_end_time: order.verification?.end_time,
            home_location_verified: order.verification?.home_location_verified,
            verification_feedback: order.verification?.verification_feedback
        })) : null;

        // Format deliveries for DO
        let formattedDeliveredProducts = null;
        if (role === 2) {
            const imeis = delivered_products.map(d => d.product_imei).filter(Boolean);
            const inventories = await prisma.outletInventory.findMany({
                where: { imei_serial: { in: imeis } },
                select: { imei_serial: true, product_name: true }
            });
            const inventoryMap = new Map(inventories.map(inv => [inv.imei_serial, inv.product_name]));

            formattedDeliveredProducts = delivered_products.map(d => ({
                order_ref: d.order?.order_ref,
                customer_name: d.order?.customer_name,
                product_name: inventoryMap.get(d.product_imei) || d.order?.product_name || 'Unknown Product',
                imei_serial: d.product_imei,
                delivery_date: d.created_at
            }));
        }

        res.json({
            success: true,
            officer,
            inventory: role === 2 ? inventory.map(t => t.inventory) : null,
            delivered_products: formattedDeliveredProducts,
            verifications: formattedOrdersForVO,
            cash,
            submission_history: submissionHistory.map(h => ({
                id: h.id,
                amount: h.amount_submitted,
                status: h.status,
                date: h.submission_date,
                order_ref: h.cash_in_hand?.order?.order_ref
            })),
            assigned_orders: assignedOrders,
            stats: {
                paid_cash: paidAmount,
                pending_cash: pendingAmount,
                total_collection: paidAmount + pendingAmount,
                verification_stats: role === 1 ? verificationStats : null
            }
        });

    } catch (error) {
        console.error('getOfficerDetails error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getOutletInstallmentsDueList = async (req, res) => {
    const { outlet_id } = req.user;
    const {
        page = 1,
        limit = 10,
        search = '',
        category = 'all', // all, regular, fresh, overdue, blacklist, defaulter, ptp, paid
        item,
        ptp,
        lock_status,
        ro_id,
        min_amount,
        max_amount,
        min_balance,
        max_balance,
        start_date,
        end_date
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;
    const q = search.trim().toLowerCase();

    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Fetch all delivered orders for the outlet
        const orders = await prisma.order.findMany({
            where: {
                is_delivered: true,
                ...(outlet_id && { outlet_id: outlet_id }),
            },
            include: {
                verification: {
                    include: {
                        purchaser: true,
                        grantors: true,
                        documents: {
                            where: { label: { in: ['Purchaser Profile', 'Grantor 1 Profile', 'Grantor 2 Profile', 'Purchaser Face Photo', 'photo - Purchaser', 'photo - Grantor 1', 'photo - Grantor 2'] } },
                            orderBy: { uploaded_at: 'desc' },
                            take: 10
                        }
                    },
                },
                delivery: {
                    include: {
                        installment_ledger: {
                            include: {
                                consumer_numbers: {
                                    select: {
                                        id: true,
                                        consumer_number: true,
                                        bill_status: true,
                                        amount_due: true,
                                        billing_month: true,
                                        due_date: true
                                    }
                                }
                            }
                        },
                    },
                },
                recovery_officer: {
                    select: {
                        id: true,
                        full_name: true,
                        phone: true
                    }
                },
                cash_in_hand: {
                    take: 1,
                    orderBy: { created_at: 'desc' },
                },
                recovery_visits: {
                    where: { promised_date: { not: null } },
                    orderBy: { created_at: 'desc' },
                    take: 1
                },
                paytrigger_devices: {
                    take: 1,
                    orderBy: { created_at: 'desc' }
                }
            }
        });

        // Pre-fetch Inventory details based on IMEI to map product_name
        const allImeis = orders
            .map(o => o.cash_in_hand?.[0]?.imei_serial || o.delivery?.product_imei || o.imei_serial)
            .filter(Boolean);

        const inventories = await prisma.outletInventory.findMany({
            where: { imei_serial: { in: allImeis } },
            select: { imei_serial: true, product_name: true }
        });

        const inventoryMap = new Map();
        for (const inv of inventories) {
            if (inv.imei_serial) {
                inventoryMap.set(inv.imei_serial, inv);
            }
        }

        // Aggregate summaries per category
        const categoriesSummary = {
            all: { amount: 0, customers: 0 },
            regular: { amount: 0, customers: 0 },
            fresh: { amount: 0, customers: 0 },
            overdue: { amount: 0, customers: 0 },
            blacklist: { amount: 0, customers: 0 },
            defaulter: { amount: 0, customers: 0 },
            ptp: { amount: 0, customers: 0 },
            paid: { amount: 0, customers: 0 }
        };

        const allInstallments = [];

        orders.forEach(order => {
            const purchaser = order.verification?.purchaser || null;
            const grantors = order.verification?.grantors || [];
            const documents = order.verification?.documents || [];

            if (purchaser && !purchaser.profile_photo) {
                const pPhoto = documents.find(d => d.label === 'photo - Purchaser' || d.label === 'Purchaser Profile');
                if (pPhoto) purchaser.profile_photo = pPhoto.file_url || pPhoto.file_path;
            }
            grantors.forEach(g => {
                if (!g.profile_photo) {
                    const gPhoto = documents.find(d => d.label === `photo - Grantor ${g.grantor_number}`);
                    if (gPhoto) g.profile_photo = gPhoto.file_url || gPhoto.file_path;
                }
            });

            const delivery = order.delivery;
            const ledgerModel = delivery?.installment_ledger || null;
            const cashRecord = order.cash_in_hand?.[0] || null;
            const device = order.paytrigger_devices?.[0] || null;

            const imeiSerial = cashRecord?.imei_serial || delivery?.product_imei || order.imei_serial || null;
            const invInfo = imeiSerial ? inventoryMap.get(imeiSerial) : null;

            let rawLedgerRows = [];
            try {
                if (ledgerModel?.ledger_rows) {
                    rawLedgerRows = Array.isArray(ledgerModel.ledger_rows)
                        ? ledgerModel.ledger_rows
                        : JSON.parse(ledgerModel.ledger_rows);
                }
            } catch (e) {
                console.error("Error parsing raw ledger rows:", e);
            }

            const normalized = getNormalizedLedger(rawLedgerRows);
            const { installment_ledger: installmentLedger, summary } = normalized;

            const pendingInstallments = installmentLedger.filter(r => r.status !== 'paid' && r.status !== 'Paid');
            const overdueInstallments = pendingInstallments.filter(r => r.dueDate && new Date(r.dueDate) < today);
            const overdueCount = overdueInstallments.length;

            let lastPaymentDate = null;
            installmentLedger.forEach(r => {
                if (r.paidAt) {
                    const pd = new Date(r.paidAt);
                    if (!lastPaymentDate || pd > lastPaymentDate) lastPaymentDate = pd;
                }
            });
            const daysSinceLastPayment = lastPaymentDate ? (today - lastPaymentDate) / (1000 * 60 * 60 * 24) : 999;

            // PTP Logic from Recovery
            const latestPtpVisit = order.recovery_visits?.[0];
            let ptpStatus = null;
            let hasPtp = false;
            if (latestPtpVisit && summary.totalInstallmentRemaining > 0) {
                ptpStatus = latestPtpVisit.promised_date < today ? 'broken' : 'active';
                hasPtp = true;
            }

            // Determine Account Category
            let accountCategory = '';
            if (summary.totalInstallmentRemaining <= 0) {
                accountCategory = 'paid';
            } else if (overdueCount >= 3 && daysSinceLastPayment >= 90) {
                accountCategory = 'defaulter';
            } else if (overdueCount >= 3) {
                accountCategory = 'blacklist';
            } else if (overdueCount === 2) {
                accountCategory = 'overdue';
            } else if (overdueCount === 1) {
                accountCategory = 'regular';
            } else {
                accountCategory = 'fresh'; // 0 overdue (due date is today or future)
            }

            const isPtp = hasPtp;

            // Find the representative installment for the table row
            let repInstallment = pendingInstallments[0]; 
            if (!repInstallment && installmentLedger.length > 0) {
                repInstallment = installmentLedger[installmentLedger.length - 1];
            }
            if (!repInstallment) return; // Ignore if no ledger

            const instDate = repInstallment.dueDate ? new Date(repInstallment.dueDate) : null;
            
            // Advance Filters Check
            let includeInGlobalList = true;
            if (start_date && end_date && instDate) {
                const sDate = new Date(start_date); sDate.setHours(0,0,0,0);
                const eDate = new Date(end_date); eDate.setHours(23,59,59,999);
                if (instDate < sDate || instDate > eDate) includeInGlobalList = false;
            }

            if (includeInGlobalList) {
                // Populate Summaries
                const addSummary = (catKey) => {
                    if (!categoriesSummary[catKey]) return;
                    categoriesSummary[catKey].customers++;
                    categoriesSummary[catKey].amount += summary.totalInstallmentRemaining;
                };

                addSummary('all');
                if (accountCategory) addSummary(accountCategory);
                if (isPtp) addSummary('ptp');

                const g1 = grantors.find(g => g.grantor_number === 1) || grantors[0] || null;
                const g2 = grantors.find(g => g.grantor_number === 2) || (grantors[0] && grantors[1] && grantors[0].id !== grantors[1].id ? grantors[1] : null);

                const matchedRawRow = rawLedgerRows.find(r => r.month === repInstallment.monthNumber);
                const paymentHistory = matchedRawRow?.payment_history || (matchedRawRow?.paid_at ? [{
                    amount: matchedRawRow.paid_amount,
                    date: matchedRawRow.paid_at,
                    method: matchedRawRow.payment_method || 'Cash'
                }] : []);

                const allConsumers = ledgerModel?.consumer_numbers || [];
                const consumerNum = allConsumers.find(c => c.consumer_number?.startsWith('1017'))?.consumer_number || allConsumers[0]?.consumer_number || null;
                const smartpayConsumerNum = allConsumers.find(c => c.consumer_number?.startsWith('6500'))?.consumer_number || null;

                const deviceStatus = device?.status || ledgerModel?.paytrigger_status || null;
                allInstallments.push({
                    order_id: order.id,
                    order_ref: order.order_ref,
                    customer_name: purchaser?.name || order.customer_name,
                    whatsapp_number: order.whatsapp_number,
                    alternate_number: purchaser?.alternate_contact || order.alternate_contact || 'N/A',
                    area: order.area || purchaser?.present_address || 'N/A',
                    dueDate: repInstallment.dueDate,
                    dueDateObj: instDate,
                    purchaseDate: order.created_at,
                    grantor1Name: g1?.name || 'N/A',
                    grantor1Phone: g1?.telephone_number || 'N/A',
                    grantor2Name: g2?.name || 'N/A',
                    grantor2Phone: g2?.telephone_number || 'N/A',
                    product_name: invInfo?.product_name || cashRecord?.product_name || order.product_name,
                    imei_serial: imeiSerial || 'N/A',
                    monthlyAmount: repInstallment.dueAmount,
                    remainingAmount: summary.totalInstallmentRemaining, 
                    partialPayment: (repInstallment.paidAmount > 0 && repInstallment.status !== 'paid') ? repInstallment.paidAmount : (repInstallment.status === 'paid' ? repInstallment.dueAmount : null),
                    paidDate: matchedRawRow?.paid_at || repInstallment.paidAt || null,
                    paymentHistory: paymentHistory,
                    note: matchedRawRow?.note || '',
                    monthNumber: repInstallment.monthNumber,
                    status: repInstallment.status || 'pending',
                    consumer_number: consumerNum,
                    smartpay_consumer_number: smartpayConsumerNum,
                    consumer_bill_status: allConsumers.find(c => c.consumer_number === consumerNum)?.bill_status || null,
                    paytrigger_status: deviceStatus,
                    recovery_officer: order.recovery_officer ? {
                        id: order.recovery_officer.id,
                        name: order.recovery_officer.full_name,
                        phone: order.recovery_officer.phone
                    } : null,
                    overdueCount,
                    daysSinceLastPayment,
                    hasPtp: isPtp,
                    ptpStatus: ptpStatus,
                    promisedDate: latestPtpVisit?.promised_date || null,
                    orderTotalMonths: installmentLedger.length,
                    orderPaidMonths: summary.paidInstallments || 0,
                    orderPaidTotal: summary.totalInstallmentPaid || 0,
                    accountCategory: accountCategory,
                    
                    // Fields for expandable InstallmentsTable
                    purchaser: purchaser || null,
                    grantors: grantors,
                    installmentLedger: installmentLedger,
                    ledgerSummaries: {
                        advanceAmount: normalized.advance_payment ? normalized.advance_payment.amount : 0,
                        monthlyAmount: repInstallment.dueAmount,
                        totalMonths: installmentLedger.length,
                        totalInstallmentDue: summary.totalInstallmentDue,
                        totalInstallmentPaid: summary.totalInstallmentPaid,
                        totalRemaining: summary.totalInstallmentRemaining,
                        paidInstallments: summary.paidInstallments,
                        totalInstallments: installmentLedger.length
                    }
                });
            }
        });

        // Sort by Due Date (ascending)
        allInstallments.sort((a, b) => {
            if (!a.dueDateObj) return 1;
            if (!b.dueDateObj) return -1;
            return a.dueDateObj - b.dueDateObj;
        });

        // Apply Primary Category Filter
        let filtered = allInstallments;

        if (category === 'regular') {
            filtered = filtered.filter(inst => inst.accountCategory === 'regular');
        } else if (category === 'fresh') {
            filtered = filtered.filter(inst => inst.accountCategory === 'fresh');
        } else if (category === 'overdue') {
            filtered = filtered.filter(inst => inst.accountCategory === 'overdue');
        } else if (category === 'blacklist') {
            filtered = filtered.filter(inst => inst.accountCategory === 'blacklist');
        } else if (category === 'defaulter') {
            filtered = filtered.filter(inst => inst.accountCategory === 'defaulter');
        } else if (category === 'ptp') {
            filtered = filtered.filter(inst => inst.hasPtp);
        } else if (category === 'paid') {
            filtered = filtered.filter(inst => inst.accountCategory === 'paid');
        }

        // Apply Search Filter
        if (q) {
            filtered = filtered.filter(inst => {
                return (
                    (inst.order_ref || '').toLowerCase().includes(q) ||
                    (inst.customer_name || '').toLowerCase().includes(q) ||
                    (inst.whatsapp_number || '').toLowerCase().includes(q) ||
                    (inst.alternate_number || '').toLowerCase().includes(q) ||
                    (inst.area || '').toLowerCase().includes(q) ||
                    (inst.grantor1Name || '').toLowerCase().includes(q) ||
                    (inst.grantor2Name || '').toLowerCase().includes(q) ||
                    (inst.product_name || '').toLowerCase().includes(q) ||
                    (inst.imei_serial || '').toLowerCase().includes(q)
                );
            });
        }

        // Apply Advanced Filters
        if (item) {
            filtered = filtered.filter(inst => (inst.product_name || '').toLowerCase().includes(item.toLowerCase()));
        }
        if (ptp === 'yes') {
            filtered = filtered.filter(inst => inst.hasPtp);
        } else if (ptp === 'no') {
            filtered = filtered.filter(inst => !inst.hasPtp);
        }
        if (lock_status) {
            filtered = filtered.filter(inst => (inst.paytrigger_status || '').toLowerCase() === lock_status.toLowerCase());
        }
        if (ro_id) {
            filtered = filtered.filter(inst => inst.recovery_officer?.id == ro_id);
        }
        if (min_amount) {
            filtered = filtered.filter(inst => inst.monthlyAmount >= Number(min_amount));
        }
        if (max_amount) {
            filtered = filtered.filter(inst => inst.monthlyAmount <= Number(max_amount));
        }
        if (min_balance) {
            filtered = filtered.filter(inst => inst.remainingAmount >= Number(min_balance));
        }
        if (max_balance) {
            filtered = filtered.filter(inst => inst.remainingAmount <= Number(max_balance));
        }

        let monthsDue = 0;
        let monthsCollected = 0;
        let systemCollected = 0;
        let systemOutstanding = 0;

        filtered.forEach(inst => {
            systemOutstanding += inst.remainingAmount;
            systemCollected += inst.orderPaidTotal;
            monthsDue += inst.monthlyAmount;
            monthsCollected += (inst.partialPayment || 0);
        });

        const totalItems = filtered.length;
        const paginated = filtered.slice(skip, skip + limitNum);

        res.json({
            success: true,
            data: {
                installments: paginated,
                pagination: {
                    total: totalItems,
                    page: pageNum,
                    limit: limitNum,
                    totalPages: Math.ceil(totalItems / limitNum)
                },
                categories_summary: categoriesSummary,
                stats: {
                    // Legacy keys for /outlet/installments
                    months_due: monthsDue,
                    months_collected: monthsCollected,
                    months_remaining: monthsDue - monthsCollected,
                    system_outstanding: systemOutstanding,
                    system_collected: systemCollected,
                    
                    // New keys for /outlet/installments/view
                    monthsDue: monthsDue,
                    monthsCollected: monthsCollected,
                    monthsRemainingAmount: monthsDue - monthsCollected,
                    overallSystemRemaining: systemOutstanding,
                    overallSystemPaid: systemCollected,
                    customerCount: categoriesSummary.all ? categoriesSummary.all.customers : 0
                }
            }
        });
    } catch (error) {
        console.error('getOutletInstallmentsDueList error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const updateInstallmentNote = async (req, res) => {
    const { id } = req.params; // Order ID
    const { note, month_number } = req.body;

    if (month_number === undefined || month_number === null) {
        return res.status(400).json({ success: false, message: 'month_number is required' });
    }

    try {
        const order = await prisma.order.findUnique({
            where: { id: parseInt(id) },
            include: {
                delivery: {
                    include: {
                        installment_ledger: true
                    }
                }
            }
        });

        const ledger = order?.delivery?.installment_ledger;
        if (!ledger) {
            return res.status(404).json({ success: false, message: 'Installment ledger not found' });
        }

        let rows = [];
        if (ledger.ledger_rows) {
            rows = Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : JSON.parse(ledger.ledger_rows);
        }

        const targetRow = rows.find(r => r.month === parseInt(month_number));
        if (!targetRow) {
            return res.status(404).json({ success: false, message: `Installment for month ${month_number} not found` });
        }

        targetRow.note = note;

        await prisma.installmentLedger.update({
            where: { id: ledger.id },
            data: {
                ledger_rows: rows,
                updated_at: now()   // ✅ explicit updated_at
            }
        });

        res.json({ success: true, message: 'Installment note updated successfully' });
    } catch (error) {
        console.error('updateInstallmentNote error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const sendBulkReminders = async (req, res) => {
    try {
        const { order_ids } = req.body;
        if (!order_ids || !Array.isArray(order_ids) || order_ids.length === 0) {
            return res.status(400).json({ success: false, message: 'No orders provided' });
        }

        const orders = await prisma.order.findMany({
            where: { id: { in: order_ids } },
            include: { delivery: true, customer: true }
        });

        const today = new Date();
        today.setHours(0,0,0,0);
        let sentCount = 0;
        const { getNormalizedLedger } = require('../utils/ledgerUtils');

        for (const order of orders) {
            const rawLedger = Array.isArray(order.delivery?.installment_ledger) ? order.delivery.installment_ledger : JSON.parse(order.delivery?.installment_ledger || '[]');
            const normalized = getNormalizedLedger(rawLedger);
            const installmentLedger = normalized.installment_ledger;
            
            const pendingInstallment = installmentLedger.find(i => i.status === 'pending');
            if (!pendingInstallment) continue;

            const phone = order.whatsapp_number;
            const customerName = order.customer?.name || order.customer_name;
            const dueDate = pendingInstallment.dueDate;
            const dueAmount = pendingInstallment.remainingAmount || pendingInstallment.dueAmount;

            if (phone && dueDate) {
                await sendNextInstallmentReminder(phone, {
                    customer_name: customerName,
                    amount_due: dueAmount,
                    due_date: new Date(dueDate).toLocaleDateString('en-PK'),
                    order_ref: order.order_ref
                }).catch(err => console.error('Wati bulk reminder error:', err));
                sentCount++;
            }
        }

        res.json({ success: true, message: `Reminders sent to ${sentCount} customers` });
    } catch (error) {
        console.error('sendBulkReminders error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// =====================
// PENDING CASH SUBMISSIONS (Outlet: see & resend OTP)
// =====================

const getPendingCashSubmissions = async (req, res) => {
    const outletId = req.user.outlet_id;
    if (!outletId) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    try {
        const pending = await prisma.cashSubmissionHistory.findMany({
            where: {
                outlet_id: outletId,
                status: 'pending'
            },
            include: {
                cash_in_hand: {
                    include: {
                        officer: { select: { id: true, full_name: true, username: true, phone: true, image: true } },
                        order: { select: { order_ref: true } }
                    }
                }
            },
            orderBy: { submission_date: 'desc' }
        });

        // Group by submission_ref
        const groupedMap = {};
        const results = [];

        pending.forEach(h => {
            const ref = h.submission_ref || `indiv_${h.id}`;
            if (!groupedMap[ref]) {
                groupedMap[ref] = {
                    submission_ref: ref,
                    total_amount: 0,
                    submitted_at: h.submission_date,
                    payment_method: h.cash_in_hand?.payment_method || 'Cash',
                    officer: h.cash_in_hand?.officer || null,
                    order_refs: []
                };
                results.push(groupedMap[ref]);
            }
            groupedMap[ref].total_amount += h.amount_submitted;
            const orderRef = h.cash_in_hand?.order?.order_ref;
            if (orderRef && !groupedMap[ref].order_refs.includes(orderRef)) {
                groupedMap[ref].order_refs.push(orderRef);
            }
        });

        return res.status(200).json({ success: true, data: results });
    } catch (error) {
        console.error('getPendingCashSubmissions error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const resendCashSubmissionOTP = async (req, res) => {
    const outletId = req.user.outlet_id;
    const { submission_ref } = req.body;

    if (!submission_ref) {
        return res.status(400).json({ success: false, message: 'submission_ref is required' });
    }

    try {
        // Find pending submissions for this ref
        const histories = await prisma.cashSubmissionHistory.findMany({
            where: { submission_ref, outlet_id: outletId, status: 'pending' },
            include: {
                cash_in_hand: {
                    include: {
                        officer: { select: { id: true, full_name: true, phone: true, fcm_token: true } }
                    }
                }
            }
        });

        if (histories.length === 0) {
            return res.status(404).json({ success: false, message: 'No pending submission found for this reference.' });
        }

        // Generate new OTP
        const newOtp = Math.floor(1000 + Math.random() * 9000).toString();

        // Update all history records with the new OTP
        await prisma.cashSubmissionHistory.updateMany({
            where: { submission_ref, outlet_id: outletId, status: 'pending' },
            data: { otp: newOtp }
        });

        const officer = histories[0].cash_in_hand.officer;
        const io = req.app.get('io');

        // Send OTP via socket to officer's app
        if (io && officer?.id) {
            io.to(`user_${officer.id}`).emit('cash_submission_otp', {
                action: 'cash_submission_otp',
                message: `Your Cash Submission OTP is: ${newOtp}`,
                otp: newOtp
            });
        }

        // Also send via Firebase if available
        const { sendCashSubmissionOTPNotification } = require('./deliveryController');
        if (sendCashSubmissionOTPNotification) {
            await sendCashSubmissionOTPNotification(officer, newOtp, io).catch(e => console.error('FCM error:', e));
        }

        return res.status(200).json({ success: true, message: 'OTP resent to officer successfully.' });
    } catch (error) {
        console.error('resendCashSubmissionOTP error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};


// ==========================================
// OUTLET TO OUTLET CASH TRANSFERS
// ==========================================

const submitCashTransferRequest = async (req, res) => {
    const { amount, receiver_outlet_id, receipt_id, description } = req.body;
    const sender_outlet_id = req.user?.outlet_id;
    const submitted_by_id = req.user?.id;
    
    const receipt_photo_url = req.file ? `/uploads/deposits/${req.file.filename}` : null;

    if (!sender_outlet_id) return res.status(403).json({ success: false, message: 'Only outlet users can transfer cash' });
    if (!amount || isNaN(amount) || amount <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });
    if (!receiver_outlet_id) return res.status(400).json({ success: false, message: 'Target outlet is required' });
    if (sender_outlet_id == receiver_outlet_id) return res.status(400).json({ success: false, message: 'Cannot transfer cash to your own outlet' });

    try {
        const transfer = await prisma.cashTransferRequest.create({
            data: {
                amount: parseFloat(amount),
                sender_outlet_id,
                receiver_outlet_id: parseInt(receiver_outlet_id),
                receipt_id: receipt_id || null,
                receipt_photo_url,
                description: description || null,
                status: 'pending',
                submitted_by_id
            }
        });

        res.json({ success: true, message: 'Transfer request submitted successfully', data: transfer });
    } catch (error) {
        console.error('submitCashTransferRequest error:', error);
        res.status(500).json({ success: false, message: 'Failed to submit transfer request' });
    }
};

const getOutgoingTransfers = async (req, res) => {
    const outlet_id = req.user?.outlet_id;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Only outlet users can access this' });

    try {
        const transfers = await prisma.cashTransferRequest.findMany({
            where: { sender_outlet_id: outlet_id },
            include: {
                receiver_outlet: { select: { id: true, name: true, code: true } },
                submitted_by: { select: { id: true, full_name: true } },
                handled_by: { select: { id: true, full_name: true } }
            },
            orderBy: { created_at: 'desc' }
        });
        res.json({ success: true, data: transfers });
    } catch (error) {
        console.error('getOutgoingTransfers error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const getIncomingTransfers = async (req, res) => {
    const outlet_id = req.user?.outlet_id;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Only outlet users can access this' });

    try {
        const transfers = await prisma.cashTransferRequest.findMany({
            where: { receiver_outlet_id: outlet_id },
            include: {
                sender_outlet: { select: { id: true, name: true, code: true } },
                submitted_by: { select: { id: true, full_name: true } },
                handled_by: { select: { id: true, full_name: true } }
            },
            orderBy: { created_at: 'desc' }
        });
        res.json({ success: true, data: transfers });
    } catch (error) {
        console.error('getIncomingTransfers error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const acceptCashTransfer = async (req, res) => {
    const { id } = req.params;
    const outlet_id = req.user?.outlet_id;
    const handled_by_id = req.user?.id;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Only outlet users can accept transfers' });

    try {
        const result = await prisma.$transaction(async (tx) => {
            const transfer = await tx.cashTransferRequest.findUnique({
                where: { id: parseInt(id) }
            });

            if (!transfer) throw new Error("Transfer not found");
            if (transfer.receiver_outlet_id !== outlet_id) throw new Error("Unauthorized to accept this transfer");
            if (transfer.status !== 'pending') throw new Error("Transfer is not in a pending state");

            const updatedTransfer = await tx.cashTransferRequest.update({
                where: { id: parseInt(id) },
                data: { status: 'accepted', handled_by_id }
            });

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            let receiverRegister = await tx.cashRegister.findFirst({
                where: { outlet_id, date: { gte: today } }
            });
            
            if (receiverRegister) {
                await tx.cashRegister.update({
                    where: { id: receiverRegister.id },
                    data: {
                        cash_transferred_in: receiverRegister.cash_transferred_in + transfer.amount,
                        closing_cash: receiverRegister.closing_cash + transfer.amount
                    }
                });
            } else {
                await tx.cashRegister.create({
                    data: {
                        outlet_id, date: today, opening_cash: 0,
                        cash_transferred_in: transfer.amount, closing_cash: transfer.amount
                    }
                });
            }

            let senderRegister = await tx.cashRegister.findFirst({
                where: { outlet_id: transfer.sender_outlet_id, date: { gte: today } }
            });

            if (senderRegister) {
                await tx.cashRegister.update({
                    where: { id: senderRegister.id },
                    data: {
                        cash_transferred_out: senderRegister.cash_transferred_out + transfer.amount,
                        closing_cash: senderRegister.closing_cash - transfer.amount
                    }
                });
            } else {
                await tx.cashRegister.create({
                    data: {
                        outlet_id: transfer.sender_outlet_id, date: today, opening_cash: 0,
                        cash_transferred_out: transfer.amount, closing_cash: -Math.abs(transfer.amount)
                    }
                });
            }
            return updatedTransfer;
        });

        res.json({ success: true, message: 'Transfer accepted successfully', data: result });
    } catch (error) {
        console.error('acceptCashTransfer error:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to accept transfer' });
    }
};

const rejectCashTransfer = async (req, res) => {
    const { id } = req.params;
    const outlet_id = req.user?.outlet_id;
    const handled_by_id = req.user?.id;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Only outlet users can reject transfers' });

    try {
        const transfer = await prisma.cashTransferRequest.findUnique({
            where: { id: parseInt(id) }
        });

        if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found' });
        if (transfer.receiver_outlet_id !== outlet_id) return res.status(403).json({ success: false, message: 'Unauthorized' });
        if (transfer.status !== 'pending') return res.status(400).json({ success: false, message: 'Transfer is not pending' });

        const updated = await prisma.cashTransferRequest.update({
            where: { id: parseInt(id) },
            data: { status: 'rejected', handled_by_id }
        });

        res.json({ success: true, message: 'Transfer rejected successfully', data: updated });
    } catch (error) {
        console.error('rejectCashTransfer error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const getBasicOutletsList = async (req, res) => {
    try {
        const outlets = await prisma.outlet.findMany({
            select: { id: true, name: true, code: true },
            orderBy: { name: 'asc' }
        });
        res.json({ success: true, data: outlets });
    } catch (error) {
        console.error('getBasicOutletsList error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const getOutletCashLimits = async (req, res) => {
    try {
        const outletId = req.user?.outlet_id;
        if (!outletId) {
            return res.status(403).json({ success: false, message: 'Only outlet users can access this.' });
        }

        // Fetch limits for officers belonging to this outlet
        // First get the users (officers) for this outlet
        const officers = await prisma.user.findMany({
            where: { outlet_id: outletId, role_id: { in: [2, 3] } }, // Delivery and Recovery officers
            select: { id: true, full_name: true }
        });
        const officerIds = officers.map(o => o.id);

        if (!officerIds.length) {
            return res.json({ success: true, data: [] });
        }

        const limits = await prisma.cashLimit.findMany({
            where: { scope_type: 'officer', scope_id: { in: officerIds } },
            orderBy: { created_at: 'desc' }
        });

        const cashByOfficer = await prisma.cashInHand.groupBy({
            by: ['officer_id'],
            where: { officer_id: { in: officerIds }, status: 'pending' },
            _sum: { amount: true, submitted_amount: true },
        });

        const officerNameById = Object.fromEntries(officers.map((o) => [o.id, o.full_name]));
        const officerPending = Object.fromEntries(cashByOfficer.map((c) => [c.officer_id, (c._sum.amount || 0) - (c._sum.submitted_amount || 0)]));

        const data = limits.map((l) => {
            const current = officerPending[l.scope_id] || 0;
            const name = officerNameById[l.scope_id] || 'Unknown officer';
            return { id: l.id, scope_type: l.scope_type, scope_id: l.scope_id, name, daily_limit: l.daily_limit, current_pending: current, is_over_limit: current > l.daily_limit };
        });

        res.json({ success: true, data });
    } catch (error) {
        console.error('getOutletCashLimits error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const setOutletCashLimit = async (req, res) => {
    try {
        const outletId = req.user?.outlet_id;
        if (!outletId) {
            return res.status(403).json({ success: false, message: 'Only outlet users can access this.' });
        }

        const { scope_type, scope_id, daily_limit } = req.body;
        if (scope_type !== 'officer' || !scope_id || daily_limit === undefined) {
            return res.status(400).json({ success: false, message: 'scope_type (officer), scope_id, and daily_limit are required.' });
        }

        // Verify the officer belongs to this outlet
        const officer = await prisma.user.findFirst({
            where: { id: parseInt(scope_id), outlet_id: outletId }
        });

        if (!officer) {
            return res.status(403).json({ success: false, message: 'Officer not found in your outlet.' });
        }

        const limit = await prisma.cashLimit.upsert({
            where: { scope_type_scope_id: { scope_type, scope_id: parseInt(scope_id) } },
            update: { daily_limit: parseFloat(daily_limit), created_by_id: req.user.id },
            create: { scope_type, scope_id: parseInt(scope_id), daily_limit: parseFloat(daily_limit), created_by_id: req.user.id },
        });

        res.json({ success: true, data: limit });
    } catch (error) {
        console.error('setOutletCashLimit error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const deleteOutletCashLimit = async (req, res) => {
    try {
        const outletId = req.user?.outlet_id;
        if (!outletId) {
            return res.status(403).json({ success: false, message: 'Only outlet users can access this.' });
        }

        const limitId = parseInt(req.params.id);
        const limit = await prisma.cashLimit.findUnique({ where: { id: limitId } });
        
        if (!limit || limit.scope_type !== 'officer') {
            return res.status(404).json({ success: false, message: 'Cash limit not found.' });
        }

        // Verify the officer belongs to this outlet
        const officer = await prisma.user.findFirst({
            where: { id: limit.scope_id, outlet_id: outletId }
        });

        if (!officer) {
            return res.status(403).json({ success: false, message: 'Officer not found in your outlet.' });
        }

        await prisma.cashLimit.delete({ where: { id: limitId } });
        res.json({ success: true, message: 'Cash limit removed.' });
    } catch (error) {
        console.error('deleteOutletCashLimit error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {

    submitCashTransferRequest,
    getOutgoingTransfers,
    getIncomingTransfers,
    acceptCashTransfer,
    rejectCashTransfer,
    getBasicOutletsList,

    createOutlet,
    getOutlets,
    getAllOutlets,
    updateOutlet,
    loginOutletUser,
    getDashboardStats,
    getGlobalCashInHand,
    verifyCashSubmissionOTP,
    getOutletCashHistory,
    getReturnExchanges,
    verifyReturnExchangeOtp,
    initiateDirectReturn,
    resendReturnOtp,
    searchDeliveredOrders,
    getOutletInstallments,
    generateInstallmentOtp,
    verifyInstallmentPayment,
    getOutletOfficers,
    getOfficerDetails,
    getOutletInstallmentsDueList,
    updateInstallmentNote,
    sendBulkReminders,
    getPendingCashSubmissions,
    resendCashSubmissionOTP,
    getOutletCashLimits,
    setOutletCashLimit,
    deleteOutletCashLimit
};
