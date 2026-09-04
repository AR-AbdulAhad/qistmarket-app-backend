const prisma = require('../../lib/prisma');
const { getScoringConfig, saveScoringConfig } = require('../utils/scoringConfigUtils');
const { updateCsrRanking } = require('../services/rankingService');
const { updateDeliveryRanking } = require('../services/deliveryRankingService');
const { updateRecoveryRanking } = require('../services/recoveryRankingService');
const { updateVerificationRanking } = require('../services/verificationRankingService');

/**
 * getOutletPerformanceSummary
 * Per-outlet order-status breakdown + pending cash-in-hand, for the
 * Admin "Outlets Management" page. Not scoped to any single outlet —
 * Admin/Super Admin see every outlet side by side.
 */
const getOutletPerformanceSummary = async (req, res) => {
    try {
        const [outlets, statusAgg, pendingCashTxns] = await Promise.all([
            prisma.outlet.findMany({ select: { id: true, name: true, code: true, type: true, status: true } }),
            prisma.order.groupBy({ by: ['outlet_id', 'status'], _count: { _all: true } }),
            prisma.officerTransaction.findMany({
                where: { type: 'credit', status: 'pending' },
                select: { amount: true, officer: { select: { outlet_id: true } } },
            }),
        ]);

        const outletMap = {};
        for (const o of outlets) {
            outletMap[o.id] = {
                outlet_id: o.id,
                outlet_name: o.name,
                outlet_code: o.code,
                type: o.type,
                status: o.status,
                totalOrders: 0,
                statusBreakdown: {},
                pendingCash: 0,
            };
        }

        for (const row of statusAgg) {
            const entry = outletMap[row.outlet_id];
            if (!entry) continue;
            entry.totalOrders += row._count._all;
            entry.statusBreakdown[row.status] = row._count._all;
        }

        for (const t of pendingCashTxns) {
            const entry = outletMap[t.officer?.outlet_id];
            if (!entry) continue;
            entry.pendingCash += t.amount;
        }

        res.json({ success: true, data: Object.values(outletMap) });
    } catch (error) {
        console.error('getOutletPerformanceSummary error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const currentPeriod = () => {
    const now = new Date();
    return { period: 'month', month: now.getMonth() + 1, year: now.getFullYear() };
};

/**
 * getUnifiedRankings
 * Combines the four department ranking tables (CSR / Verification /
 * Delivery / Recovery) — each already maintained by its own portal's
 * ranking service — into one response for the Admin "Rankings &
 * Leaderboards" page.
 */
const tierFor = (score) => (score >= 1500 ? 'Gold' : score >= 1000 ? 'Silver' : 'Bronze');

const avgMinutes = (rows) => {
    const durations = rows.filter((r) => r.start_time && r.end_time).map((r) => (new Date(r.end_time) - new Date(r.start_time)) / 60000);
    if (durations.length === 0) return null;
    return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
};

const getUnifiedRankings = async (req, res) => {
    try {
        const { period, month, year } = currentPeriod();
        const userInclude = {
            select: { full_name: true, username: true, outlet: { select: { id: true, name: true } } },
        };

        const startOfMonth = new Date(year, month - 1, 1);
        const endOfMonth = new Date(year, month, 1);

        let [csr, verification, delivery, recovery] = await Promise.all([
            prisma.csrRanking.findMany({ where: { period, month, year }, orderBy: { rank: 'asc' }, include: { user: userInclude } }),
            prisma.verificationRanking.findMany({ where: { period, month, year }, orderBy: { rank: 'asc' }, include: { user: userInclude } }),
            prisma.deliveryRanking.findMany({ where: { period, month, year }, orderBy: { rank: 'asc' }, include: { user: userInclude } }),
            prisma.recoveryRanking.findMany({ where: { period, month, year }, orderBy: { rank: 'asc' }, include: { user: userInclude } }),
        ]);

        // ── Live fallback: if recovery ranking table is empty for this month,
        //    compute rankings on-the-fly from recovery visits so leaderboard
        //    is never blank even before the ranking service triggers.
        if (recovery.length === 0) {
            const recoveryOfficers = await prisma.user.findMany({
                where: { role: { name: 'Recovery Officer' } },
                include: { outlet: { select: { id: true, name: true } } },
            });

            const liveRows = await Promise.all(
                recoveryOfficers.map(async (officer, idx) => {
                    const visits = await prisma.recoveryVisit.findMany({
                        where: { officer_id: officer.id, visit_time: { gte: startOfMonth, lt: endOfMonth } },
                        select: { payment_collected: true, amount_collected: true },
                    });
                    const orders = await prisma.order.findMany({
                        where: { recovery_officer_id: officer.id, updated_at: { gte: startOfMonth, lt: endOfMonth } },
                        select: { status: true },
                    });
                    const collectedVisits = visits.filter(v => v.payment_collected).length;
                    const completedOrders = orders.filter(o => o.status === 'completed').length;
                    const cancelledOrders = orders.filter(o => o.status === 'cancelled').length;
                    const expiredOrders = orders.filter(o => o.status === 'expired').length;
                    const score = (collectedVisits * 15) + (completedOrders * 5) - (cancelledOrders * 2) - (expiredOrders * 3);
                    return {
                        id: officer.id,
                        officer_id: officer.id,
                        score,
                        rank: 0,
                        trend: 0,
                        total_sales: visits.reduce((s, v) => s + (v.amount_collected || 0), 0),
                        unique_customers: 0,
                        delivered_customers: 0,
                        user: { full_name: officer.full_name, username: officer.username, outlet: officer.outlet },
                        // live KPIs already available
                        _liveVisits: visits,
                    };
                })
            );

            // Sort by score desc and assign ranks
            liveRows.sort((a, b) => b.score - a.score);
            liveRows.forEach((r, i) => { r.rank = i + 1; });
            recovery = liveRows;
        }

        const shape = (rows) => rows.map((r) => ({
            id: r.id,
            officer_id: r.officer_id ?? r.csr_id,
            full_name: r.user?.full_name || 'Unknown',
            username: r.user?.username || '',
            outlet_name: r.user?.outlet?.name || 'Unassigned',
            outlet_id: r.user?.outlet?.id || null,
            score: r.score,
            rank: r.rank,
            trend: r.trend,
            total_sales: r.total_sales,
            unique_customers: r.unique_customers,
            delivered_customers: r.delivered_customers,
            tier: tierFor(r.score),
        }));

        const csrShaped = shape(csr);
        const verificationShaped = shape(verification);
        const deliveryShaped = shape(delivery);
        const recoveryShaped = shape(recovery);

        // Supplementary KPIs — computed from the underlying source tables
        // (not stored on the ranking rows themselves) for the top-10 rows
        // already returned per board, so this stays a bounded query volume.

        await Promise.all([
            ...verificationShaped.map(async (row) => {
                const orders = await prisma.order.findMany({
                    where: { assigned_to_user_id: row.officer_id, verification_assigned_at: { gte: startOfMonth, lt: endOfMonth } },
                    select: { status: true },
                });
                row.total_verifications = orders.length;
                row.approved_verifications = orders.filter((o) => o.status === 'completed').length;
                row.rejected_verifications = orders.filter((o) => o.status === 'rejected').length;
                row.score = row.approved_verifications * 10;
                row.tier = tierFor(row.score);
            }),
            ...deliveryShaped.map(async (row) => {
                const orders = await prisma.order.findMany({
                    where: { delivery_officer_id: row.officer_id, delivery_assigned_at: { gte: startOfMonth, lt: endOfMonth } },
                    select: { status: true },
                });
                row.successful_deliveries = orders.filter((o) => o.status === 'delivered').length;
                row.failed_deliveries = orders.filter((o) => ['cancelled', 'failed', 'rejected'].includes(o.status)).length;
                row.score = row.successful_deliveries * 10;
                row.tier = tierFor(row.score);
            }),
            ...recoveryShaped.map(async (row) => {
                // Live-fallback rows already have visits cached
                const visits = row._liveVisits ?? await prisma.recoveryVisit.findMany({
                    where: { officer_id: row.officer_id, visit_time: { gte: startOfMonth, lt: endOfMonth } },
                    select: { payment_collected: true, amount_collected: true },
                });
                row.visit_count = visits.length;
                row.amount_collected = visits.reduce((s, v) => s + (v.amount_collected || 0), 0);
                row.recovery_rate = visits.length > 0 ? Math.round((visits.filter(v => v.payment_collected).length / visits.length) * 1000) / 10 : 0;
                row.missed_visits = visits.filter((v) => !v.payment_collected).length;
                row.score = Math.floor(row.amount_collected / 1000); // 1 point per 1000 Rs recovered
                row.tier = tierFor(row.score);
                delete row._liveVisits;
            }),
            ...csrShaped.map(async (row) => {
                row.conversion_rate = row.unique_customers > 0 ? Math.round((row.delivered_customers / row.unique_customers) * 1000) / 10 : 0;
            }),
        ]);

        // Re-rank based on accurate live scores
        verificationShaped.sort((a,b) => b.score - a.score).forEach((r, i) => r.rank = i + 1);
        deliveryShaped.sort((a,b) => b.score - a.score).forEach((r, i) => r.rank = i + 1);
        recoveryShaped.sort((a,b) => b.score - a.score).forEach((r, i) => r.rank = i + 1);

        const filterByOutlet = (rows) => {
            if (req.user && req.user.outlet_id) {
                const filtered = rows.filter(r => r.outlet_id === req.user.outlet_id);
                // Re-rank for the filtered list
                return filtered.map((r, idx) => ({ ...r, rank: idx + 1 }));
            }
            return rows;
        };

        res.json({
            success: true,
            data: {
                period: { period, month, year },
                csr: filterByOutlet(csrShaped),
                verification: filterByOutlet(verificationShaped),
                delivery: filterByOutlet(deliveryShaped),
                recovery: filterByOutlet(recoveryShaped),
            },
        });
    } catch (error) {
        console.error('getUnifiedRankings error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getOutletRankings
 * Computed on-the-fly (not persisted, unlike officer rankings) — ranks
 * outlets by a blended score of this month's sales, recovery %, and
 * installment on-time performance. No new schema; the four officer
 * ranking tables already set the precedent that "ranking" doesn't
 * require a dedicated always-on service for every board.
 */
const getOutletRankings = async (req, res) => {
    try {
        const now = new Date();
        // `month` is 1-indexed from the client (1 = January), defaulting to the current month/year.
        const year = parseInt(req.query.year) || now.getFullYear();
        const month = req.query.month ? parseInt(req.query.month) : now.getMonth() + 1;
        const startOfMonth = new Date(year, month - 1, 1);
        const startOfNextMonth = new Date(year, month, 1);

        const outlets = await prisma.outlet.findMany({ where: { type: { not: 'warehouse' } }, select: { id: true, name: true, code: true } });

        const orders = await prisma.order.findMany({
            where: {
                outlet_id: { in: outlets.map((o) => o.id) },
                status: 'delivered',
                OR: [
                    { delivered_at: { gte: startOfMonth, lt: startOfNextMonth } },
                    { AND: [{ delivered_at: null }, { updated_at: { gte: startOfMonth, lt: startOfNextMonth } }] },
                ],
            },
            select: { outlet_id: true, total_amount: true, installment_ledger: { select: { ledger_rows: true } } },
        });

        const returnedOrders = await prisma.order.findMany({
            where: {
                outlet_id: { in: outlets.map((o) => o.id) },
                status: 'returned',
                updated_at: { gte: startOfMonth, lt: startOfNextMonth },
            },
            select: { outlet_id: true },
        });

        const cancelledOrders = await prisma.order.findMany({
            where: {
                outlet_id: { in: outlets.map((o) => o.id) },
                status: 'cancelled',
                updated_at: { gte: startOfMonth, lt: startOfNextMonth },
            },
            select: { outlet_id: true },
        });

        const stats = {};
        for (const o of outlets) stats[o.id] = { outlet_id: o.id, outlet_name: o.name, outlet_code: o.code, totalSales: 0, dueAmount: 0, recoveredAmount: 0, customerCount: 0, returnedCount: 0, cancelledCount: 0 };

        for (const order of orders) {
            const entry = stats[order.outlet_id];
            if (!entry) continue;

            entry.totalSales += order.total_amount || 0;
            entry.customerCount += 1;

            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];
            for (const row of rows) {
                const amount = parseFloat(row.amount || row.dueAmount || 0);
                const paidAmount = parseFloat(row.paid_amount || (row.status === 'paid' ? amount : 0)) || 0;
                entry.dueAmount += amount;
                entry.recoveredAmount += Math.min(paidAmount, amount);
            }
        }

        for (const order of returnedOrders) {
            const entry = stats[order.outlet_id];
            if (entry) entry.returnedCount += 1;
        }

        for (const order of cancelledOrders) {
            const entry = stats[order.outlet_id];
            if (entry) entry.cancelledCount += 1;
        }

        const scoringCfg = getScoringConfig().outlet;

        const ranked = Object.values(stats).map((s) => {
            const recoveryPct = s.dueAmount > 0 ? (s.recoveredAmount / s.dueAmount) * 100 : 0;
            
            const salesPts = (s.totalSales / (scoringCfg.sales_divisor || 1000)) * (scoringCfg.sales_multiplier ?? 1);
            const recPts = recoveryPct * (scoringCfg.recovery_pct_multiplier ?? 5);
            const delPts = s.customerCount * (scoringCfg.points_per_delivered_order ?? 10);
            const retPts = (s.returnedCount || 0) * (scoringCfg.points_deducted_per_returned_order ?? 10);
            const canPts = (s.cancelledCount || 0) * (scoringCfg.points_deducted_per_cancelled_order ?? 0);

            const score = Math.round(salesPts + recPts + delPts - retPts - canPts);
            return { ...s, recoveryPercentage: Math.round(recoveryPct * 10) / 10, score };
        }).sort((a, b) => b.score - a.score)
          .map((s, idx) => ({ ...s, rank: idx + 1, tier: tierFor(s.score) }));

        res.json({ success: true, data: ranked, month, year });
    } catch (error) {
        console.error('getOutletRankings error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getScoringRulesConfig = async (req, res) => {
    try {
        const config = getScoringConfig();
        return res.json({ success: true, data: config });
    } catch (error) {
        console.error('getScoringRulesConfig error:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch scoring rules.' });
    }
};

const updateScoringRulesConfig = async (req, res) => {
    try {
        const result = saveScoringConfig(req.body);
        if (!result.success) {
            return res.status(500).json({ success: false, message: result.error || 'Failed to save rules' });
        }

        recalculateAllOfficerRankings().catch(err => console.error('Recalculation error after config update:', err));

        return res.json({ success: true, message: 'Scoring rules updated successfully.', data: result.config });
    } catch (error) {
        console.error('updateScoringRulesConfig error:', error);
        return res.status(500).json({ success: false, message: 'Failed to update scoring rules.' });
    }
};

const recalculateAllOfficerRankings = async () => {
    const users = await prisma.user.findMany({ select: { id: true } });
    for (const u of users) {
        await updateCsrRanking(u.id, 'month').catch(() => {});
        await updateCsrRanking(u.id, 'today').catch(() => {});
        await updateDeliveryRanking(u.id, 'month').catch(() => {});
        await updateRecoveryRanking(u.id, 'month').catch(() => {});
        await updateVerificationRanking(u.id, 'month').catch(() => {});
    }
};

const triggerRankingsRecalculation = async (req, res) => {
    try {
        await recalculateAllOfficerRankings();
        return res.json({ success: true, message: 'All rankings recalculated successfully.' });
    } catch (error) {
        console.error('triggerRankingsRecalculation error:', error);
        return res.status(500).json({ success: false, message: 'Failed to recalculate rankings.' });
    }
};

/**
 * getMissedRecoveryTracking
 * Recovery officers with orders assigned to them that have zero
 * RecoveryVisit rows in the last 14 days — a proxy for "missed"
 * follow-up, since there's no explicit "missed visit" flag in the schema.
 */
const getMissedRecoveryTracking = async (req, res) => {
    try {
        const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

        const assignedOrders = await prisma.order.findMany({
            where: { recovery_officer_id: { not: null }, status: { notIn: ['Cancelled', 'Rejected', 'Completed'] }, is_delivered: true },
            select: {
                id: true, order_ref: true, customer_name: true, recovery_officer_id: true,
                recovery_officer: { select: { full_name: true } },
                recovery_visits: { where: { visit_time: { gte: cutoff } }, select: { id: true }, take: 1 },
            },
        });

        const missed = assignedOrders
            .filter((o) => o.recovery_visits.length === 0)
            .map((o) => ({ order_id: o.id, order_ref: o.order_ref, customer_name: o.customer_name, officer_id: o.recovery_officer_id, officer_name: o.recovery_officer?.full_name || 'Unassigned' }));

        res.json({ success: true, data: { count: missed.length, items: missed } });
    } catch (error) {
        console.error('getMissedRecoveryTracking error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getProductSalesReport
 * Product-wise sales + top-selling products, grouped from Order.product_name
 * on delivered orders. Brand-wise sales isn't included — there's no brand
 * field anywhere on Order or OutletInventory to group by.
 */
const getProductSalesReport = async (req, res) => {
    try {
        const orders = await prisma.order.groupBy({
            by: ['product_name'],
            where: { status: { in: ['delivered', 'completed'] } },
            _count: { _all: true },
            _sum: { total_amount: true },
        });

        const products = orders
            .map((o) => ({ product_name: o.product_name, unitsSold: o._count._all, totalRevenue: o._sum.total_amount || 0 }))
            .sort((a, b) => b.unitsSold - a.unitsSold);

        res.json({ success: true, data: { products, topSelling: products.slice(0, 10) } });
    } catch (error) {
        console.error('getProductSalesReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getInstallmentStatusCounts
 * Active vs. closed (all rows paid) installment counts, company-wide —
 * derived from ledger_rows, no schema change (no stored "closed" flag).
 */
const getInstallmentStatusCounts = async (req, res) => {
    try {
        const orders = await prisma.order.findMany({
            where: { status: { notIn: ['Cancelled', 'Rejected'] }, is_delivered: true },
            select: { installment_ledger: { select: { ledger_rows: true } } },
        });

        let active = 0;
        let closed = 0;
        for (const order of orders) {
            const rows = Array.isArray(order.installment_ledger?.ledger_rows) ? order.installment_ledger.ledger_rows : [];
            if (rows.length === 0) continue;
            const allPaid = rows.every((r) => r.status === 'paid');
            if (allPaid) closed += 1;
            else active += 1;
        }

        res.json({ success: true, data: { active, closed, total: active + closed } });
    } catch (error) {
        console.error('getInstallmentStatusCounts error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getAttendanceMonitoring
 * Today's attendance rolled up per outlet, via Employee.outlet_id — HR's
 * EmployeeAttendance table already exists; this is a new outlet-grouped
 * view over it for the Admin Outlets page.
 */
const getAttendanceMonitoring = async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [employees, attendanceToday, unlinkedOfficerCounts] = await Promise.all([
            prisma.employee.findMany({ where: { portal_active: true }, select: { id: true, outlet_id: true } }),
            prisma.employeeAttendance.findMany({ where: { date: today }, select: { employee_id: true, status: true } }),
            // Officers with a User login at this outlet but no linked HR
            // Employee record — see linkEmployeesToUsers.js. These people
            // are working but invisible to attendance tracking entirely.
            prisma.user.findMany({ where: { outlet_id: { not: null }, employee_profile: null }, select: { outlet_id: true } }),
        ]);

        const attendanceByEmployee = Object.fromEntries(attendanceToday.map((a) => [a.employee_id, a.status]));
        const outlets = await prisma.outlet.findMany({ select: { id: true, name: true } });
        const outletMap = {};
        for (const o of outlets) outletMap[o.id] = { outlet_id: o.id, outlet_name: o.name, totalStaff: 0, present: 0, absent: 0, notMarked: 0, unlinkedOfficers: 0 };

        for (const emp of employees) {
            const entry = outletMap[emp.outlet_id];
            if (!entry) continue;
            entry.totalStaff += 1;
            const status = attendanceByEmployee[emp.id];
            if (!status) entry.notMarked += 1;
            else if (status === 'present') entry.present += 1;
            else entry.absent += 1;
        }

        for (const u of unlinkedOfficerCounts) {
            const entry = outletMap[u.outlet_id];
            if (entry) entry.unlinkedOfficers += 1;
        }

        res.json({ success: true, data: Object.values(outletMap).filter((o) => o.totalStaff > 0 || o.unlinkedOfficers > 0) });
    } catch (error) {
        console.error('getAttendanceMonitoring error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getPayrollSummary
 * Company-wide payroll totals by month — PayrollSlip only had a
 * per-employee endpoint (GET /api/hr/employees/:id/payroll) before this;
 * this is the missing company-wide rollup for the Admin Reports Hub.
 */
const getPayrollSummary = async (req, res) => {
    try {
        const slips = await prisma.payrollSlip.findMany({
            orderBy: [{ year: 'desc' }, { month: 'desc' }],
            include: { employee: { select: { full_name: true, department: true } } },
            take: 200,
        });

        const summary = {};
        for (const s of slips) {
            const key = `${s.year}-${String(s.month).padStart(2, '0')}`;
            if (!summary[key]) summary[key] = { month: key, totalNetPayable: 0, employeeCount: 0, paidCount: 0 };
            summary[key].totalNetPayable += s.net_payable;
            summary[key].employeeCount += 1;
            if (s.status === 'paid') summary[key].paidCount += 1;
        }

        res.json({
            success: true,
            data: {
                monthly: Object.values(summary),
                slips: slips.map((s) => ({ id: s.id, employee_name: s.employee?.full_name || 'Unknown', department: s.employee?.department || '—', month: s.month, year: s.year, net_payable: s.net_payable, status: s.status })),
            },
        });
    } catch (error) {
        console.error('getPayrollSummary error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getDeliveryManagementOverview
 * Lightweight company-wide delivery aggregate — status counts, today's
 * total, and a per-officer breakdown. Deliberately NOT a port of the
 * single-officer getDeliveryOfficerAnalytics (deliveryAnalyticsController.js,
 * ~250 lines) — that function is scoped and shaped for one officer's own
 * dashboard and is too large/risky to globalize wholesale.
 */
const getDeliveryManagementOverview = async (req, res) => {
    try {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const [statusAgg, todayCount, officerAgg] = await Promise.all([
            prisma.delivery.groupBy({ by: ['status'], _count: { _all: true } }),
            prisma.delivery.count({ where: { created_at: { gte: startOfDay } } }),
            prisma.delivery.groupBy({ by: ['delivery_agent_id', 'status'], _count: { _all: true } }),
        ]);

        const officerIds = [...new Set(officerAgg.map((o) => o.delivery_agent_id).filter(Boolean))];
        const officers = officerIds.length
            ? await prisma.user.findMany({ where: { id: { in: officerIds } }, select: { id: true, full_name: true, username: true, outlet: { select: { name: true } } } })
            : [];
        const officerById = Object.fromEntries(officers.map((o) => [o.id, o]));

        const officerMap = {};
        for (const row of officerAgg) {
            const key = row.delivery_agent_id;
            if (!key) continue;
            if (!officerMap[key]) {
                officerMap[key] = {
                    officer_id: key,
                    full_name: officerById[key]?.full_name || 'Unknown',
                    username: officerById[key]?.username || '',
                    outlet_name: officerById[key]?.outlet?.name || 'Unassigned',
                    total: 0,
                    statusBreakdown: {},
                };
            }
            officerMap[key].total += row._count._all;
            officerMap[key].statusBreakdown[row.status] = row._count._all;
        }

        res.json({
            success: true,
            data: {
                statusBreakdown: Object.fromEntries(statusAgg.map((s) => [s.status, s._count._all])),
                totalToday: todayCount,
                officerWise: Object.values(officerMap).sort((a, b) => b.total - a.total),
            },
        });
    } catch (error) {
        console.error('getDeliveryManagementOverview error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * syncBadges
 * Admin/Super Admin-triggered (not an auto-cron, to avoid adding a new
 * background job to a live system). Reads the same current-month ranking
 * rows getUnifiedRankings already reads and upserts a persisted Badge row
 * for rank <= 3 per department, so achievements survive past the current
 * ranking period instead of being purely derived/ephemeral.
 */
const syncBadges = async (req, res) => {
    try {
        const { period, month, year } = currentPeriod();
        const departments = [
            { key: 'csr', model: prisma.csrRanking },
            { key: 'verification', model: prisma.verificationRanking },
            { key: 'delivery', model: prisma.deliveryRanking },
            { key: 'recovery', model: prisma.recoveryRanking },
        ];

        let awarded = 0;
        for (const dept of departments) {
            const topRows = await dept.model.findMany({ where: { period, month, year, rank: { lte: 3 } } });
            for (const row of topRows) {
                const badge_type = row.rank === 1 ? 'champion' : 'top_performer';
                await prisma.badge.upsert({
                    where: { user_id_department_period_month_year: { user_id: row.officer_id ?? row.csr_id, department: dept.key, period, month, year } },
                    update: { badge_type, awarded_at: new Date() },
                    create: { user_id: row.officer_id ?? row.csr_id, department: dept.key, badge_type, period, month, year },
                });
                awarded += 1;
            }
        }

        res.json({ success: true, message: `Synced ${awarded} badge(s) for ${month}/${year}.`, data: { awarded } });
    } catch (error) {
        console.error('syncBadges error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getBadges
 * Badge history — most recent first, with the user's name/outlet resolved.
 */
const getBadges = async (req, res) => {
    try {
        const badges = await prisma.badge.findMany({
            orderBy: [{ year: 'desc' }, { month: 'desc' }, { awarded_at: 'desc' }],
            include: { user: { select: { full_name: true, username: true, outlet: { select: { name: true } } } } },
            take: 100,
        });

        res.json({
            success: true,
            data: badges.map((b) => ({
                id: b.id,
                full_name: b.user?.full_name || 'Unknown',
                username: b.user?.username || '',
                outlet_name: b.user?.outlet?.name || 'Unassigned',
                department: b.department,
                badge_type: b.badge_type,
                month: b.month,
                year: b.year,
                awarded_at: b.awarded_at,
            })),
        });
    } catch (error) {
        console.error('getBadges error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getOutletStaffList
 * outletController.getOutletOfficers reads req.user.outlet_id directly
 * (no query-param fallback), so it only works for outlet-logged-in users
 * — not reusable for Admin, whose token has no outlet_id. This is the
 * Admin-facing equivalent: any outlet, any role, via ?outlet_id=.
 */
/**
 * getOutletStaffList
 * outletController.getOutletOfficers reads req.user.outlet_id directly
 * (no query-param fallback), so it only works for outlet-logged-in users
 * — not reusable for Admin, whose token has no outlet_id. This is the
 * Admin-facing equivalent: any outlet, any role, via ?outlet_id=.
 */
const getOutletStaffList = async (req, res) => {
    const { outlet_id } = req.query;
    if (!outlet_id) return res.status(400).json({ success: false, message: 'outlet_id is required.' });

    try {
        const staff = await prisma.user.findMany({
            where: { outlet_id: parseInt(outlet_id) },
            select: { id: true, full_name: true, username: true, phone: true, status: true, is_online: true, role: { select: { name: true } }, employee_profile: { select: { id: true } } },
            orderBy: { full_name: 'asc' },
        });

        res.json({
            success: true,
            data: staff.map((s) => ({
                id: s.id, full_name: s.full_name, username: s.username, phone: s.phone, status: s.status, is_online: s.is_online, role: s.role?.name || 'Unknown',
                // Whether this login account has a linked HR Employee record —
                // see linkEmployeesToUsers.js. Unlinked officers won't show up
                // in Attendance Monitoring since that's Employee-based.
                has_employee_record: !!s.employee_profile,
            })),
        });
    } catch (error) {
        console.error('getOutletStaffList error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * hardDeleteOrderCascade
 * Irreversibly deletes an order and its entire child graph (ConsumerNumbers,
 * InstallmentLedger, Delivery, Verification, Purchaser, Grantors, Documents,
 * Locations, OrderStatusHistories, OrderPayments, CashInHand, PayTrigger,
 * SmartPay, RecoveryVisits, etc.). If the Customer record has no remaining
 * orders afterward, it is cleaned up too.
 *
 * Looks the order up regardless of soft-delete state (`deleted_at: undefined`
 * opts out of lib/prisma.js's default "hide deleted orders" filter) — callers
 * are expected to have already verified the order belongs in the recycle bin
 * before invoking this.
 */
const hardDeleteOrderCascade = async (orderId) => {
  const order = await prisma.order.findUnique({
    where: { id: orderId, deleted_at: undefined },
    include: {
      verification: {
        include: {
          verification_locations: { include: { photos: true } },
        },
      },
      delivery: { include: { installment_ledger: true } },
      installment_ledger: true,
    },
  });

  if (!order) {
    return { success: false, message: 'Order not found.' };
  }

  const customerId = order.customer_id;
  const verificationId = order.verification?.id || null;
  const deliveryId = order.delivery?.id || null;
  const ledgerId = order.installment_ledger?.id || order.delivery?.installment_ledger?.id || null;

  // 1. Delete ConsumerNumbers
  if (ledgerId || deliveryId) {
    const consumerWhere = [];
    if (ledgerId) consumerWhere.push({ ledger_id: ledgerId });
    if (deliveryId) consumerWhere.push({ delivery_id: deliveryId });
    await prisma.consumerNumber.deleteMany({ where: { OR: consumerWhere } });
  }

  // 2. Delete InstallmentLedger
  await prisma.installmentLedger.deleteMany({ where: { order_id: orderId } });

  // 3. Delete Deliveries & ArchivedDeliveries
  await prisma.delivery.deleteMany({ where: { order_id: orderId } });
  await prisma.archivedDelivery.deleteMany({ where: { order_id: orderId } });

  // 4. Delete Verification details (purchaser, grantors, docs, locations & photos, reviews)
  if (verificationId) {
    const verLocs = order.verification?.verification_locations || [];
    const locIds = verLocs.map((l) => l.id);
    if (locIds.length > 0) {
      await prisma.verificationLocationPhoto.deleteMany({ where: { verification_location_id: { in: locIds } } });
      await prisma.verificationLocation.deleteMany({ where: { verification_id: verificationId } });
    }
    await prisma.purchaserVerification.deleteMany({ where: { verification_id: verificationId } });
    await prisma.grantorVerification.deleteMany({ where: { verification_id: verificationId } });
    await prisma.nextOfKinVerification.deleteMany({ where: { verification_id: verificationId } });
    await prisma.verificationDocument.deleteMany({ where: { verification_id: verificationId } });
    await prisma.verificationReview.deleteMany({ where: { verification_id: verificationId } });
    await prisma.locationTracking.deleteMany({ where: { verification_id: verificationId } });
    await prisma.verification.deleteMany({ where: { id: verificationId } });
  }

  // 5. Delete Order histories, payments, cash in hand, paytrigger, smartpay, complaints, visits
  await prisma.orderStatusHistory.deleteMany({ where: { order_id: orderId } });
  await prisma.orderProductHistory.deleteMany({ where: { order_id: orderId } });
  await prisma.orderPayment.deleteMany({ where: { order_id: orderId } });
  await prisma.cashInHand.deleteMany({ where: { order_id: orderId } });
  await prisma.payTriggerDevice.deleteMany({ where: { order_id: orderId } });
  await prisma.smartPayQr.deleteMany({ where: { order_id: orderId } });
  await prisma.recoveryVisit.deleteMany({ where: { order_id: orderId } });
  await prisma.returnExchange.deleteMany({ where: { order_id: orderId } });
  await prisma.dummyCustomer.deleteMany({ where: { order_id: orderId } });
  await prisma.complaint.updateMany({ where: { order_id: orderId }, data: { order_id: null } });

  // 6. Delete Order itself
  await prisma.order.delete({ where: { id: orderId } });

  // 7. Cleanup orphaned Customer record if no other orders (including ones
  // still sitting in the recycle bin) reference them
  if (customerId) {
    const remainingOrdersCount = await prisma.order.count({ where: { customer_id: customerId, deleted_at: undefined } });
    if (remainingOrdersCount === 0) {
      await prisma.customer.delete({ where: { id: customerId } }).catch(() => {});
    }
  }

  return { success: true, message: `Order #${orderId} (${order.order_ref}) and all associated records permanently deleted.` };
};

/**
 * deleteOrderPermanently
 * Super Admin-only. Moves an order to the Recycle Bin (soft delete) — the
 * order and its child graph are untouched, it just stops showing up
 * anywhere in the app (see lib/prisma.js's default order-read filter).
 * The irreversible cascade delete now lives behind the Recycle Bin's
 * "Delete Permanently" action (permanentlyDeleteOrders below).
 */
const deleteOrderPermanently = async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  if (isNaN(orderId)) {
    return res.status(400).json({ success: false, message: 'Invalid order ID.' });
  }

  try {
    const order = await prisma.order.update({
      where: { id: orderId, deleted_at: null },
      data: { deleted_at: new Date(), deleted_by: req.user?.id || null },
    });

    return res.json({ success: true, message: `Order #${orderId} (${order.order_ref}) moved to Recycle Bin.` });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Order not found (it may already be in the Recycle Bin).' });
    }
    console.error('deleteOrderPermanently error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete order: ' + (error.message || 'Internal server error') });
  }
};

/**
 * listRecycleBinOrders
 * Super Admin-only. Lists soft-deleted orders for the Recycle Bin page.
 */
const listRecycleBinOrders = async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { deleted_at: { not: null } },
      orderBy: { deleted_at: 'desc' },
      select: {
        id: true,
        order_ref: true,
        customer_name: true,
        whatsapp_number: true,
        product_name: true,
        total_amount: true,
        status: true,
        deleted_at: true,
        deleted_by: true,
        verification: {
          select: {
            purchaser: {
              select: {
                name: true
              }
            }
          }
        }
      },
    });

    const deleterIds = [...new Set(orders.map((o) => o.deleted_by).filter(Boolean))];
    const deleters = deleterIds.length
      ? await prisma.user.findMany({ where: { id: { in: deleterIds } }, select: { id: true, full_name: true } })
      : [];
    const deleterNameById = Object.fromEntries(deleters.map((u) => [u.id, u.full_name]));

    const result = orders.map((o) => {
      const purchaser = o.verification?.purchaser;
      const purchaserName = purchaser?.name || o.customer_name;
      return {
        id: o.id,
        order_ref: o.order_ref,
        customer_name: purchaserName,
        whatsapp_number: o.whatsapp_number,
        product_name: o.product_name,
        total_amount: o.total_amount,
        status: o.status,
        deleted_at: o.deleted_at,
        deleted_by: o.deleted_by,
        deleted_by_name: o.deleted_by ? (deleterNameById[o.deleted_by] || null) : null
      };
    });

    return res.json({ success: true, orders: result });
  } catch (error) {
    console.error('listRecycleBinOrders error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load Recycle Bin: ' + (error.message || 'Internal server error') });
  }
};

/**
 * restoreOrders
 * Super Admin-only. Un-deletes one or more orders — they reappear
 * everywhere exactly as before.
 */
const restoreOrders = async (req, res) => {
  const orderIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id)) : [];
  if (orderIds.length === 0) {
    return res.status(400).json({ success: false, message: 'No order IDs provided.' });
  }

  try {
    const result = await prisma.order.updateMany({
      where: { id: { in: orderIds }, deleted_at: { not: null } },
      data: { deleted_at: null, deleted_by: null },
    });

    return res.json({ success: true, message: `${result.count} order(s) restored.`, restoredCount: result.count });
  } catch (error) {
    console.error('restoreOrders error:', error);
    return res.status(500).json({ success: false, message: 'Failed to restore orders: ' + (error.message || 'Internal server error') });
  }
};

/**
 * permanentlyDeleteOrders
 * Super Admin-only. The real, irreversible cascade delete — only allowed on
 * orders already sitting in the Recycle Bin (deleted_at IS NOT NULL), so the
 * soft-delete step can never be skipped from this endpoint.
 */
const permanentlyDeleteOrders = async (req, res) => {
  const orderIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id)) : [];
  if (orderIds.length === 0) {
    return res.status(400).json({ success: false, message: 'No order IDs provided.' });
  }

  try {
    const binOrders = await prisma.order.findMany({
      where: { id: { in: orderIds }, deleted_at: { not: null } },
      select: { id: true },
    });
    const binOrderIds = new Set(binOrders.map((o) => o.id));

    const results = [];
    for (const orderId of orderIds) {
      if (!binOrderIds.has(orderId)) {
        results.push({ orderId, success: false, message: 'Order is not in the Recycle Bin.' });
        continue;
      }
      const outcome = await hardDeleteOrderCascade(orderId);
      results.push({ orderId, ...outcome });
    }

    const successCount = results.filter((r) => r.success).length;
    return res.json({
      success: successCount > 0,
      message: `${successCount} of ${orderIds.length} order(s) permanently deleted.`,
      results,
    });
  } catch (error) {
    console.error('permanentlyDeleteOrders error:', error);
    return res.status(500).json({ success: false, message: 'Failed to permanently delete orders: ' + (error.message || 'Internal server error') });
  }
};

module.exports = {
    getOutletPerformanceSummary,
    getUnifiedRankings,
    getDeliveryManagementOverview,
    syncBadges,
    getBadges,
    getOutletRankings,
    getMissedRecoveryTracking,
    getProductSalesReport,
    getInstallmentStatusCounts,
    getAttendanceMonitoring,
    getPayrollSummary,
    getOutletStaffList,
    deleteOrderPermanently,
    listRecycleBinOrders,
    restoreOrders,
    permanentlyDeleteOrders,
    getScoringRulesConfig,
    updateScoringRulesConfig,
    triggerRankingsRecalculation,
};

