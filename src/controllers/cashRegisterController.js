const prisma = require('../../lib/prisma');

// Helper for current timestamp
const now = () => new Date();

// Helper to calculate Pakistan Local Time (UTC+5)
const getPKTDate = (d = new Date()) => {
    const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
    return new Date(utc + (3600000 * 5));
};

const isAfter10PM_PKT = () => {
    const pkt = getPKTDate();
    return pkt.getHours() >= 22;
};

/**
 * Computes live metrics for a specific outlet and date range.
 * Rules:
 * - Physical Cash Register: ONLY payment_method === 'Cash'
 * - Digital Bank Total: Bank Transfer / Online payments
 * - Digital 1Bill Total: 1Bill / 1LINK payments
 */
const computeMetricsForPeriod = async (outletId, startDate, endDate) => {
    const dateFilter = {
        gte: startDate,
        lte: endDate
    };

    // 1. Opening Cash = the TRUE cumulative net cash flow of every order/
    // expense/payment strictly before `startDate`, computed live from source
    // data — not a single persisted CashRegister row's `closing_cash` (which
    // can be missing or stale if "Sync Daily Ledger" wasn't run every day).
    // This is what makes "Expected Cash" correct for every filter: Today
    // still carries everything before today, Week/Month carry everything
    // before that window, and Custom carries everything before the chosen
    // start date — not just the flow inside the selected window.
    // Recursion bottoms out in exactly one extra call: the recursive
    // invocation is given `startDate = EPOCH`, so its own `startDate > EPOCH`
    // check is false and it returns 0 immediately without recursing further.
    const EPOCH = new Date(0);
    let openingCash = 0;
    if (startDate > EPOCH) {
        const priorPeriod = await computeMetricsForPeriod(
            outletId,
            EPOCH,
            new Date(startDate.getTime() - 1)
        );
        openingCash = priorPeriod.expected_cash;
    }

    // 2. Down Payments (Cash In)
    const downPaymentOrders = await prisma.order.findMany({
        where: {
            outlet_id: outletId,
            created_at: dateFilter
        },
        select: {
            advance_amount: true,
            channel: true
        }
    });

    let downPaymentsCash = 0;
    let downPaymentsBank = 0;
    let downPayments1Bill = 0;

    downPaymentOrders.forEach(o => {
        const amt = parseFloat(o.advance_amount || 0);
        const ch = (o.channel || 'Cash').toLowerCase();

        if (ch.includes('bank') || ch.includes('transfer')) {
            downPaymentsBank += amt;
        } else if (ch.includes('1bill') || ch.includes('1link')) {
            downPayments1Bill += amt;
        } else {
            downPaymentsCash += amt;
        }
    });

    // 3. Installments Received (Cash In)
    const installmentPayments = await prisma.orderPayment.findMany({
        where: {
            paidAt: dateFilter,
            paymentType: 'installment',
            order: { outlet_id: outletId }
        },
        select: {
            amount: true,
            paymentMethod: true
        }
    });

    let installmentsCash = 0;
    let installmentsBank = 0;
    let installments1Bill = 0;

    installmentPayments.forEach(p => {
        const amt = parseFloat(p.amount || 0);
        const pm = (p.paymentMethod || 'Cash').toLowerCase();
        if (pm === 'cash' || pm === 'manual_deposit' || pm === 'recovery_cash' || pm === 'recovery cash' || !p.paymentMethod) {
            installmentsCash += amt;
        } else if (pm.includes('bank') || pm.includes('transfer') || pm.includes('online')) {
            installmentsBank += amt;
        } else if (pm.includes('1bill') || pm.includes('1link')) {
            installments1Bill += amt;
        }
    });

    // 4. Cash from Recovery & Delivery Officers
    const verifiedSubmissions = await prisma.cashSubmissionHistory.findMany({
        where: {
            outlet_id: outletId,
            status: 'paid',
            submission_date: dateFilter
        },
        include: {
            cash_in_hand: {
                include: {
                    officer: {
                        select: {
                            role_id: true,
                            role: { select: { name: true } }
                        }
                    }
                }
            }
        }
    });

    let cashFromRecovery = 0;
    let cashFromDelivery = 0;

    verifiedSubmissions.forEach(sub => {
        const amt = parseFloat(sub.amount_submitted || 0);
        const roleId = sub.cash_in_hand?.officer?.role_id;
        const roleName = (sub.cash_in_hand?.officer?.role?.name || '').toLowerCase();
        if (roleId === 3 || roleName.includes('recovery')) {
            cashFromRecovery += amt;
        } else {
            cashFromDelivery += amt;
        }
    });

    if (cashFromRecovery === 0 && cashFromDelivery === 0) {
        const cashInHandRecords = await prisma.cashInHand.findMany({
            where: {
                outlet_id: outletId,
                updated_at: dateFilter,
                status: { in: ['paid', 'accepted', 'approved', 'submitted', 'completed'] }
            },
            include: {
                officer: { select: { role_id: true, role: { select: { name: true } } } }
            }
        });

        cashInHandRecords.forEach(c => {
            const amt = parseFloat(c.submitted_amount || c.amount || 0);
            const roleId = c.officer?.role_id;
            const roleName = (c.officer?.role?.name || '').toLowerCase();
            if (roleId === 3 || roleName.includes('recovery')) {
                cashFromRecovery += amt;
            } else {
                cashFromDelivery += amt;
            }
        });
    }

    // 5. Outflows: Expenses
    const expenseVouchers = await prisma.expenseVoucher.findMany({
        where: {
            outlet_id: outletId,
            created_at: dateFilter,
            status: { in: ['approved', 'paid'] }
        },
        select: {
            total_amount: true,
            payment_method: true
        }
    });

    let expensesCash = 0;
    expenseVouchers.forEach(ev => {
        const amt = parseFloat(ev.total_amount || 0);
        const pm = (ev.payment_method || 'Cash').toLowerCase();
        if (pm === 'cash' || !ev.payment_method) {
            expensesCash += amt;
        }
    });

    // 6. Outflows: Vendor Payments
    const vendorPayments = await prisma.vendorPayment.findMany({
        where: {
            outlet_id: outletId,
            created_at: dateFilter
        },
        select: {
            amount: true,
            payment_method: true
        }
    });

    let vendorPaymentsCash = 0;
    vendorPayments.forEach(vp => {
        const amt = parseFloat(vp.amount || 0);
        const pm = (vp.payment_method || 'Cash').toLowerCase();
        if (pm === 'cash' || !vp.payment_method) {
            vendorPaymentsCash += amt;
        }
    });

    // 5b. Cash Sale (walk-in outright/non-installment sales against outlet stock)
    const cashSales = await prisma.cashSale.findMany({
        where: { outlet_id: outletId, created_at: dateFilter },
        select: { final_price: true }
    });
    const cashSaleTotal = cashSales.reduce((sum, s) => sum + parseFloat(s.final_price || 0), 0);

    // 6b. Generic vendor ledger cash transactions (Manage Vendors > Record Payment)
    // 'debit'  = Payment Out to Vendor (cash leaves the drawer)
    // 'credit' = Payment In from Vendor (cash enters the drawer)
    const vendorCashTransactions = await prisma.vendorCashTransaction.findMany({
        where: {
            created_at: dateFilter,
            vendor: { outlet_id: outletId }
        },
        select: { type: true, amount: true }
    });

    let vendorReceiptsCash = 0;
    vendorCashTransactions.forEach(vt => {
        const amt = parseFloat(vt.amount || 0);
        if (vt.type === 'debit') {
            vendorPaymentsCash += amt;
        } else if (vt.type === 'credit') {
            vendorReceiptsCash += amt;
        }
    });

    // 7. Outflows: Customer Refunds
    const customerRefunds = await prisma.returnExchange.findMany({
        where: {
            outlet_id: outletId,
            created_at: dateFilter,
            is_cash_refund: true
        },
        select: { refund_amount: true }
    });

    let refundsCash = 0;
    customerRefunds.forEach(cr => {
        refundsCash += parseFloat(cr.refund_amount || 0);
    });

    // 8. Inter-Outlet Transfers
    const transfersIn = await prisma.cashTransferRequest.findMany({
        where: { receiver_outlet_id: outletId, status: 'accepted', created_at: dateFilter },
        select: { amount: true }
    });

    const transfersOut = await prisma.cashTransferRequest.findMany({
        where: { sender_outlet_id: outletId, status: 'accepted', created_at: dateFilter },
        select: { amount: true }
    });

    const cashTransferredIn = transfersIn.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);
    const cashTransferredOut = transfersOut.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);

    // Compute Master Formula:
    // Expected Cash = Opening Cash + Cash Inflows - Cash Outflows
    const totalCashIn = downPaymentsCash + installmentsCash + cashFromRecovery + cashFromDelivery + vendorReceiptsCash + cashSaleTotal + cashTransferredIn;
    const totalCashOut = expensesCash + vendorPaymentsCash + refundsCash + cashTransferredOut;
    const expectedCash = openingCash + totalCashIn - totalCashOut;

    return {
        opening_cash: openingCash,
        down_payments: downPaymentsCash,
        installments_received: installmentsCash,
        cash_from_recovery: cashFromRecovery,
        cash_from_delivery: cashFromDelivery,
        expenses: expensesCash + refundsCash,
        vendor_payments: vendorPaymentsCash,
        vendor_receipts: vendorReceiptsCash,
        cash_sale: cashSaleTotal,
        cash_transferred_in: cashTransferredIn,
        cash_transferred_out: cashTransferredOut,
        closing_cash: expectedCash,
        expected_cash: expectedCash,
        // Net cash movement inside THIS selected window only (excludes opening
        // cash carried over from before it) — shown alongside expected_cash so
        // the UI can display both "moved during this period" and "overall".
        period_net_change: totalCashIn - totalCashOut,
        digital_bank_total: downPaymentsBank + installmentsBank,
        digital_1bill_total: downPayments1Bill + installments1Bill
    };
};

/**
 * GET /api/outlet/cash-register
 * Supports query filter: filter=today|week|month|custom, startDate, endDate
 */
const getCashRegister = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    const { filter = 'today', startDate, endDate } = req.query;

    try {
        let start = new Date();
        start.setHours(0, 0, 0, 0);
        let end = new Date();
        end.setHours(23, 59, 59, 999);

        if (filter === 'week') {
            start = new Date();
            start.setDate(start.getDate() - 7);
            start.setHours(0, 0, 0, 0);
        } else if (filter === 'month') {
            start = new Date();
            start.setDate(1);
            start.setHours(0, 0, 0, 0);
        } else if (filter === 'custom' && startDate && endDate) {
            start = new Date(startDate);
            start.setHours(0, 0, 0, 0);
            end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
        }

        // Register Archives is a full history log, independent of the Master
        // Ledger Cards' active date filter above — it must not collapse to a
        // single row just because "Today" is selected. Capped to the most
        // recent year of daily entries as a sane upper bound.
        const registers = await prisma.cashRegister.findMany({
            where: { outlet_id },
            orderBy: { date: 'desc' },
            take: 365
        });

        // Compute metrics for the active filter range
        const computedMetrics = await computeMetricsForPeriod(outlet_id, start, end);

        // Fetch today's register state for lock/reconciliation status
        const todayZero = new Date();
        todayZero.setHours(0, 0, 0, 0);
        let todayRegister = await prisma.cashRegister.findUnique({
            where: { outlet_id_date: { outlet_id, date: todayZero } }
        });

        // Check if locked via 10:00 PM PKT rule or explicit lock
        const lockedByTime = isAfter10PM_PKT();
        const isLocked = Boolean(todayRegister?.is_locked || todayRegister?.register_status === 'closed' || lockedByTime);

        res.json({
            success: true,
            filter,
            metrics: computedMetrics,
            todayRegister: todayRegister ? { ...todayRegister, is_locked: isLocked } : null,
            isLocked,
            registers
        });
    } catch (error) {
        console.error('getCashRegister error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /api/outlet/cash-register/calculate
 * Syncs daily ledger and updates today's CashRegister database record.
 */
const calculateDailyCash = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);

        let register = await prisma.cashRegister.findUnique({
            where: { outlet_id_date: { outlet_id, date: today } }
        });

        // Check if locked
        if (register && (register.is_locked || register.register_status === 'closed')) {
            return res.status(400).json({
                success: false,
                message: 'Today cash register is locked/closed. Reopen is required to modify.',
                register
            });
        }

        const metrics = await computeMetricsForPeriod(outlet_id, today, todayEnd);

        if (!register) {
            register = await prisma.cashRegister.create({
                data: {
                    outlet_id,
                    date: today,
                    ...metrics,
                    created_at: now(),
                    updated_at: now()
                }
            });
        } else {
            register = await prisma.cashRegister.update({
                where: { id: register.id },
                data: {
                    ...metrics,
                    updated_at: now()
                }
            });
        }

        res.json({ success: true, message: 'Daily ledger synced successfully!', register });
    } catch (error) {
        console.error('calculateDailyCash error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /api/outlet/cash-register/reconcile
 * Submits Physical Cash Count and Difference Reason.
 */
const submitReconciliation = async (req, res) => {
    const { outlet_id } = req.user;
    const { physical_cash, difference_reason } = req.body;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    if (physical_cash === undefined || physical_cash === null) {
        return res.status(400).json({ success: false, message: 'Physical cash count is required.' });
    }

    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let register = await prisma.cashRegister.findUnique({
            where: { outlet_id_date: { outlet_id, date: today } }
        });

        if (!register) {
            const todayEnd = new Date();
            todayEnd.setHours(23, 59, 59, 999);
            const metrics = await computeMetricsForPeriod(outlet_id, today, todayEnd);
            register = await prisma.cashRegister.create({
                data: { outlet_id, date: today, ...metrics, created_at: now(), updated_at: now() }
            });
        }

        if (register.is_locked || register.register_status === 'closed') {
            return res.status(400).json({ success: false, message: 'Cash register is locked/closed.' });
        }

        const physical = parseFloat(physical_cash);
        const difference = physical - register.expected_cash;

        if (difference !== 0 && (!difference_reason || !difference_reason.trim())) {
            return res.status(400).json({
                success: false,
                message: 'Difference reason is required when Physical Cash does not match Expected Cash.'
            });
        }

        const oldValues = { physical_cash: register.physical_cash, register_status: register.register_status };
        const newValues = { physical_cash: physical, difference, difference_reason, register_status: 'pending_approval' };

        const updatedRegister = await prisma.cashRegister.update({
            where: { id: register.id },
            data: {
                physical_cash: physical,
                difference,
                difference_reason: difference_reason ? difference_reason.trim() : null,
                register_status: 'pending_approval',
                updated_at: now()
            }
        });

        // Audit Log
        await prisma.securityLog.create({
            data: {
                outlet_id,
                user_id: req.user.id,
                user_name: req.user.username || req.user.full_name || 'Outlet Manager',
                action: 'CASH_REGISTER_RECONCILE',
                details: `Physical cash count submitted: PKR ${physical}. Difference: PKR ${difference}. Reason: ${difference_reason || 'N/A'}`,
                target_id: updatedRegister.id,
                target_type: 'CashRegister',
                old_value: oldValues,
                new_value: newValues
            }
        });

        res.json({
            success: true,
            message: 'Physical cash count submitted for approval.',
            register: updatedRegister
        });
    } catch (error) {
        console.error('submitReconciliation error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /api/outlet/cash-register/approve
 * Manager/Admin approves register closing & settlement.
 */
const approveRegister = async (req, res) => {
    const { outlet_id } = req.user;
    const userRole = (req.user?.role || '').toLowerCase();

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const register = await prisma.cashRegister.findUnique({
            where: { outlet_id_date: { outlet_id, date: today } },
            include: { outlet: { select: { code: true } } }
        });

        if (!register) {
            return res.status(404).json({ success: false, message: 'Today cash register record not found.' });
        }

        const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
        const settlementNumber = `SET-${register.outlet?.code || outlet_id}-${dateStr}-${register.id}`;

        const oldValues = {
            manager_approval_status: register.manager_approval_status,
            register_status: register.register_status,
            is_locked: register.is_locked
        };

        const updatedRegister = await prisma.cashRegister.update({
            where: { id: register.id },
            data: {
                manager_approval_status: 'approved',
                approved_by_user_id: req.user.id,
                approved_at: now(),
                register_status: 'closed',
                is_locked: true,
                locked_at: now(),
                settlement_number: settlementNumber,
                settlement_status: 'Pending',
                updated_at: now()
            }
        });

        const newValues = {
            manager_approval_status: 'approved',
            register_status: 'closed',
            is_locked: true,
            settlement_number: settlementNumber
        };

        // Audit Log
        await prisma.securityLog.create({
            data: {
                outlet_id,
                user_id: req.user.id,
                user_name: req.user.username || req.user.full_name || 'Manager',
                action: 'CASH_REGISTER_APPROVE',
                details: `Cash register approved & closed. Settlement Voucher ${settlementNumber} generated.`,
                target_id: updatedRegister.id,
                target_type: 'CashRegister',
                old_value: oldValues,
                new_value: newValues
            }
        });

        res.json({
            success: true,
            message: `Register approved & closed! Settlement Voucher ${settlementNumber} created.`,
            register: updatedRegister
        });
    } catch (error) {
        console.error('approveRegister error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /api/outlet/cash-register/reopen
 * Super Admin only — reopens a locked register.
 */
const reopenRegister = async (req, res) => {
    const userRole = (req.user?.role || '').toLowerCase();
    if (!userRole.includes('super admin') && !userRole.includes('admin')) {
        return res.status(403).json({ success: false, message: 'Only Super Admin can reopen a locked register.' });
    }

    const { register_id } = req.body;
    if (!register_id) return res.status(400).json({ success: false, message: 'register_id is required.' });

    try {
        const register = await prisma.cashRegister.findUnique({
            where: { id: parseInt(register_id) }
        });

        if (!register) return res.status(404).json({ success: false, message: 'Register not found.' });

        const oldValues = { register_status: register.register_status, is_locked: register.is_locked };

        const updatedRegister = await prisma.cashRegister.update({
            where: { id: register.id },
            data: {
                register_status: 'open',
                is_locked: false,
                manager_approval_status: 'pending',
                updated_at: now()
            }
        });

        const newValues = { register_status: 'open', is_locked: false, manager_approval_status: 'pending' };

        // Audit Log
        await prisma.securityLog.create({
            data: {
                outlet_id: register.outlet_id,
                user_id: req.user.id,
                user_name: req.user.username || req.user.full_name || 'Super Admin',
                action: 'CASH_REGISTER_REOPEN',
                details: `Locked register ID ${register.id} reopened by Super Admin.`,
                target_id: register.id,
                target_type: 'CashRegister',
                old_value: oldValues,
                new_value: newValues
            }
        });

        res.json({ success: true, message: 'Register unlocked and reopened successfully.', register: updatedRegister });
    } catch (error) {
        console.error('reopenRegister error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /api/outlet/cash-register/history
 * Register Archives, reshaped: one entry per CATEGORY (Down Payments,
 * Installments, Recovery, Delivery, Cash from Vendor, Expenses, Vendor
 * Payments), each carrying its own list of individual transactions
 * (with real date+time) so the UI can render "category row → expand →
 * full transaction history" instead of one wide row per calendar day.
 * Always the outlet's full history (capped at the most recent 200
 * transactions per category) — independent of any date filter, same as
 * the previous Register Archives table.
 */
const MAX_HISTORY_PER_CATEGORY = 200;

const getCashRegisterHistory = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    try {
        // ── Down Payments (Cash channel only) ──────────────────────────
        const downPaymentOrders = await prisma.order.findMany({
            where: {
                outlet_id,
                advance_amount: { gt: 0 },
            },
            select: { id: true, order_ref: true, customer_name: true, advance_amount: true, channel: true, created_at: true },
            orderBy: { created_at: 'desc' },
            take: MAX_HISTORY_PER_CATEGORY
        });
        const downPayments = downPaymentOrders
            .filter(o => {
                const ch = (o.channel || 'Cash').toLowerCase();
                return !ch.includes('bank') && !ch.includes('transfer') && !ch.includes('1bill') && !ch.includes('1link');
            })
            .map(o => ({
                id: `dp-${o.id}`,
                date: o.created_at,
                title: o.customer_name || 'Customer',
                subtitle: `Order ${o.order_ref} — Down Payment`,
                amount: parseFloat(o.advance_amount || 0)
            }));

        // ── Installments Received (Cash-ish methods only) ──────────────
        const installmentPayments = await prisma.orderPayment.findMany({
            where: {
                paymentType: 'installment',
                order: { outlet_id }
            },
            select: {
                id: true, amount: true, paymentMethod: true, paidAt: true, monthNumber: true,
                order: { select: { order_ref: true, customer_name: true } }
            },
            orderBy: { paidAt: 'desc' },
            take: MAX_HISTORY_PER_CATEGORY
        });
        const installmentsReceived = installmentPayments
            .filter(p => {
                const pm = (p.paymentMethod || 'Cash').toLowerCase();
                return pm === 'cash' || pm === 'manual_deposit' || pm === 'recovery_cash' || pm === 'recovery cash' || !p.paymentMethod;
            })
            .map(p => ({
                id: `inst-${p.id}`,
                date: p.paidAt,
                title: p.order?.customer_name || 'Customer',
                subtitle: `Order ${p.order?.order_ref || 'N/A'} — Month ${p.monthNumber ?? '-'}`,
                amount: parseFloat(p.amount || 0)
            }));

        // ── Cash from Recovery / Delivery Officers ─────────────────────
        const verifiedSubmissions = await prisma.cashSubmissionHistory.findMany({
            where: { outlet_id, status: 'paid' },
            include: {
                cash_in_hand: {
                    include: { officer: { select: { full_name: true, username: true, role_id: true, role: { select: { name: true } } } } }
                }
            },
            orderBy: { submission_date: 'desc' },
            take: MAX_HISTORY_PER_CATEGORY
        });

        let recoverySource = verifiedSubmissions;
        let usingFallback = false;
        if (verifiedSubmissions.length === 0) {
            usingFallback = true;
        }

        const cashFromRecovery = [];
        const cashFromDelivery = [];

        recoverySource.forEach(sub => {
            const officer = sub.cash_in_hand?.officer;
            const roleId = officer?.role_id;
            const roleName = (officer?.role?.name || '').toLowerCase();
            const entry = {
                id: `sub-${sub.id}`,
                date: sub.submission_date,
                title: officer?.full_name || officer?.username || 'Officer',
                subtitle: 'Cash Submission',
                amount: parseFloat(sub.amount_submitted || 0)
            };
            if (roleId === 3 || roleName.includes('recovery')) cashFromRecovery.push(entry);
            else cashFromDelivery.push(entry);
        });

        if (usingFallback) {
            const cashInHandRecords = await prisma.cashInHand.findMany({
                where: { outlet_id, status: { in: ['paid', 'accepted', 'approved', 'submitted', 'completed'] } },
                include: { officer: { select: { full_name: true, username: true, role_id: true, role: { select: { name: true } } } } },
                orderBy: { updated_at: 'desc' },
                take: MAX_HISTORY_PER_CATEGORY
            });
            cashInHandRecords.forEach(c => {
                const roleId = c.officer?.role_id;
                const roleName = (c.officer?.role?.name || '').toLowerCase();
                const entry = {
                    id: `cih-${c.id}`,
                    date: c.updated_at,
                    title: c.officer?.full_name || c.officer?.username || 'Officer',
                    subtitle: 'Cash in Hand',
                    amount: parseFloat(c.submitted_amount || c.amount || 0)
                };
                if (roleId === 3 || roleName.includes('recovery')) cashFromRecovery.push(entry);
                else cashFromDelivery.push(entry);
            });
        }

        // ── Expenses ────────────────────────────────────────────────────
        const expenseVouchers = await prisma.expenseVoucher.findMany({
            where: { outlet_id, status: { in: ['approved', 'paid'] } },
            select: {
                id: true, voucher_number: true, total_amount: true, payment_method: true, notes: true, created_at: true,
                items: { select: { category: true } }
            },
            orderBy: { created_at: 'desc' },
            take: MAX_HISTORY_PER_CATEGORY
        });
        const expenses = expenseVouchers
            .filter(ev => {
                const pm = (ev.payment_method || 'Cash').toLowerCase();
                return pm === 'cash' || !ev.payment_method;
            })
            .map(ev => {
                const categories = [...new Set((ev.items || []).map(i => i.category || 'General'))];
                return {
                    id: `exp-${ev.id}`,
                    date: ev.created_at,
                    title: ev.voucher_number,
                    subtitle: categories.length > 0 ? categories.join(', ') : (ev.notes || 'Outlet Expense'),
                    amount: parseFloat(ev.total_amount || 0)
                };
            });

        // ── Vendor Payments (out): VendorPayment + debit VendorCashTransaction ──
        const vendorPaymentsRaw = await prisma.vendorPayment.findMany({
            where: { outlet_id },
            select: { id: true, amount: true, payment_method: true, vendor_name: true, created_at: true },
            orderBy: { created_at: 'desc' },
            take: MAX_HISTORY_PER_CATEGORY
        });
        const vendorCashTransactions = await prisma.vendorCashTransaction.findMany({
            where: { vendor: { outlet_id } },
            select: { id: true, type: true, amount: true, description: true, created_at: true, vendor: { select: { name: true } } },
            orderBy: { created_at: 'desc' },
            take: MAX_HISTORY_PER_CATEGORY
        });

        const vendorPayments = [
            ...vendorPaymentsRaw
                .filter(vp => {
                    const pm = (vp.payment_method || 'Cash').toLowerCase();
                    return pm === 'cash' || !vp.payment_method;
                })
                .map(vp => ({
                    id: `vp-${vp.id}`,
                    date: vp.created_at,
                    title: vp.vendor_name || 'Vendor',
                    subtitle: 'Invoice Settlement',
                    amount: parseFloat(vp.amount || 0)
                })),
            ...vendorCashTransactions
                .filter(vt => vt.type === 'debit')
                .map(vt => ({
                    id: `vct-out-${vt.id}`,
                    date: vt.created_at,
                    title: vt.vendor?.name || 'Vendor',
                    subtitle: vt.description || 'Payment Out',
                    amount: parseFloat(vt.amount || 0)
                }))
        ].sort((a, b) => new Date(b.date) - new Date(a.date));

        // ── Cash from Vendor (in): credit VendorCashTransaction ────────
        const cashFromVendor = vendorCashTransactions
            .filter(vt => vt.type === 'credit')
            .map(vt => ({
                id: `vct-in-${vt.id}`,
                date: vt.created_at,
                title: vt.vendor?.name || 'Vendor',
                subtitle: vt.description || 'Payment In',
                amount: parseFloat(vt.amount || 0)
            }));

        // ── Cash Sale (walk-in outright sales against outlet stock) ────
        const cashSaleRecords = await prisma.cashSale.findMany({
            where: { outlet_id },
            select: { id: true, product_name: true, imei_serial: true, customer_name: true, final_price: true, created_at: true },
            orderBy: { created_at: 'desc' },
            take: MAX_HISTORY_PER_CATEGORY
        });
        const cashSale = cashSaleRecords.map(cs => ({
            id: `cs-${cs.id}`,
            date: cs.created_at,
            title: cs.customer_name || 'Walk-in Customer',
            subtitle: `${cs.product_name}${cs.imei_serial ? ` — ${cs.imei_serial}` : ''}`,
            amount: parseFloat(cs.final_price || 0)
        }));

        const buildCategory = (label, key, transactions) => ({
            label,
            key,
            count: transactions.length,
            total: transactions.reduce((s, t) => s + t.amount, 0),
            transactions
        });

        res.json({
            success: true,
            categories: [
                buildCategory('Down Payments', 'down_payments', downPayments),
                buildCategory('Installments Received', 'installments_received', installmentsReceived),
                buildCategory('Cash from Recovery', 'cash_from_recovery', cashFromRecovery),
                buildCategory('Cash from Delivery', 'cash_from_delivery', cashFromDelivery),
                buildCategory('Cash from Vendor', 'cash_from_vendor', cashFromVendor),
                buildCategory('Cash Sale', 'cash_sale', cashSale),
                buildCategory('Expenses', 'expenses', expenses),
                buildCategory('Vendor Payments', 'vendor_payments', vendorPayments),
            ]
        });
    } catch (error) {
        console.error('getCashRegisterHistory error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getCashRegister,
    getCashRegisterHistory,
    calculateDailyCash,
    submitReconciliation,
    approveRegister,
    reopenRegister,
    computeMetricsForPeriod
};