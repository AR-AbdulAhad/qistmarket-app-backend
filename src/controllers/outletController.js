const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwtConfig');
const bcrypt = require('bcrypt');
const { updateCashRegister } = require('../utils/cashRegisterUtils');

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
            data: { code, name, address }
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
                ...(status && { status })
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
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const firstDayOfWeek = new Date();
        firstDayOfWeek.setDate(firstDayOfWeek.getDate() - firstDayOfWeek.getDay());
        firstDayOfWeek.setHours(0, 0, 0, 0);

        const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

        // Filter orders by this outlet
        const outletOrders = await prisma.order.findMany({
            where: { outlet_id }
        });

        const pendingVerification = outletOrders.filter(o => o.status === 'Pending Verification').length;
        const approvedOrders = outletOrders.filter(o => o.status === 'Approved').length;
        const rejectedOrders = outletOrders.filter(o => o.status === 'Rejected').length;
        const deliveryPending = outletOrders.filter(o => o.status === 'Ready for Delivery').length;

        // Performance:
        const dailySales = outletOrders.filter(o => o.created_at >= today).reduce((acc, o) => acc + o.total_amount, 0);
        const weeklySales = outletOrders.filter(o => o.created_at >= firstDayOfWeek).reduce((acc, o) => acc + o.total_amount, 0);
        const monthlySales = outletOrders.filter(o => o.created_at >= firstDayOfMonth).reduce((acc, o) => acc + o.total_amount, 0);

        // Financial Overview (using CashRegister table for latest snapshot)
        const latestRegister = await prisma.cashRegister.findFirst({
            where: { outlet_id },
            orderBy: { date: 'desc' }
        });

        res.json({
            success: true,
            stats: {
                orders: {
                    todayOrders: outletOrders.filter(o => o.created_at >= today).length,
                    pendingVerification,
                    approvedOrders,
                    rejectedOrders,
                    deliveryPending
                },
                performance: {
                    dailySales,
                    weeklySales,
                    monthlySales
                },
                financials: latestRegister || {
                    down_payments: 0,
                    installments_received: 0,
                    cash_from_recovery: 0,
                    cash_from_delivery: 0,
                    expenses: 0,
                    closing_cash: 0
                }
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
            where: { status: 'pending' },
            include: {
                delivery_officer: { select: { full_name: true, phone: true } },
                order: {
                    select: {
                        order_ref: true,
                        delivery: { select: { selected_plan: true } }
                    }
                },
                outlet: { select: { name: true } }
            },
            orderBy: { created_at: 'desc' }
        });

        return res.status(200).json({
            success: true,
            data: entries
        });
    } catch (error) {
        console.error('getGlobalCashInHand error:', error);
        return res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
};

const verifyCashSubmissionOTP = async (req, res) => {
    const { otp, outlet_id } = req.body;

    if (!otp || !outlet_id) {
        return res.status(400).json({ success: false, message: 'OTP and outlet_id are required' });
    }

    try {
        const entries = await prisma.cashInHand.findMany({
            where: {
                outlet_id: parseInt(outlet_id),
                otp: otp,
                status: 'pending'
            }
        });

        if (entries.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid OTP or no pending submissions found' });
        }

        await prisma.cashInHand.updateMany({
            where: {
                id: { in: entries.map(e => e.id) }
            },
            data: {
                status: 'paid',
                otp: null
            }
        });

        // Sum amounts
        const totalAmount = entries.reduce((sum, e) => sum + e.amount, 0);

        // Update Cash Register
        await updateCashRegister(null, parseInt(outlet_id), 'cash_from_delivery', totalAmount, 'add');

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
    const { date_from, date_to, officer_id } = req.query;
    const outletId = req.user.outlet_id;

    try {
        let where = { status: 'paid' };

        if (outletId) {
            where.outlet_id = outletId;
        }

        if (officer_id) {
            where.delivery_officer_id = parseInt(officer_id);
        }

        if (date_from || date_to) {
            where.created_at = {};
            if (date_from) where.created_at.gte = new Date(date_from);
            if (date_to) where.created_at.lte = new Date(date_to);
        }

        const entries = await prisma.cashInHand.findMany({
            where,
            include: {
                delivery_officer: { select: { full_name: true, phone: true } },
                order: {
                    select: {
                        order_ref: true,
                        delivery: { select: { selected_plan: true } }
                    }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        return res.status(200).json({
            success: true,
            data: entries
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
        return res.json({ success: true, data: records });
    } catch (error) {
        console.error('getReturnExchanges error:', error);
        return res.status(500).json({ success: false, error: 'Server error' });
    }
};

const verifyReturnExchangeOtp = async (req, res) => {
    const outlet_id = req.user.outlet_id;
    const { record_id, otp } = req.body;

    try {
        const result = await prisma.$transaction(async (tx) => {
            const record = await tx.returnExchange.findUnique({
                where: { id: parseInt(record_id) },
                include: { order: true }
            });

            if (!record) throw new Error('Record not found');
            if (record.outlet_id !== outlet_id) throw new Error('Not authorized for this outlet');
            if (record.status === 'verified') throw new Error('Already verified');
            if (record.otp !== otp) throw new Error('Invalid OTP');

            // 1. Mark verified
            const updatedRecord = await tx.returnExchange.update({
                where: { id: record.id },
                data: {
                    status: 'verified',
                    verified_at: new Date(),
                }
            });

            // 2. Change order status and clear IMEI if needed
            const isExchange = record.type === 'Exchange';
            await tx.order.update({
                where: { id: record.order_id },
                data: {
                    status: isExchange ? 'approved' : 'Returned',
                    imei_serial: isExchange ? null : record.order.imei_serial, // Clear IMEI for fresh assignment during exchange
                    is_delivered: false // Mark as not delivered so it shows up in delivery list again
                }
            });

            // 3. Update stock (Sold -> In Stock)
            if (record.imei_returned) {
                const inventory = await tx.outletInventory.findFirst({
                    where: { imei_serial: record.imei_returned, outlet_id: parseInt(outlet_id) }
                });

                if (inventory) {
                    await tx.outletInventory.update({
                        where: { id: inventory.id },
                        data: { status: 'In Stock' }
                    });

                    // 4. Stock Transfer log
                    await tx.stockTransfer.create({
                        data: {
                            inventory_id: inventory.id,
                            from_type: 'DeliveryOfficer',
                            from_id: record.delivery_officer_id,
                            to_type: 'Outlet',
                            to_id: parseInt(outlet_id),
                            status: 'completed',
                            quantity_transferred: 1,
                        }
                    });
                }
            }

            return updatedRecord;
        });

        return res.json({ success: true, message: 'Returned stock successfully taken back via OTP verification.', data: result });
    } catch (error) {
        console.error('verifyReturnExchangeOtp error:', error);
        return res.status(400).json({ success: false, error: error.message || 'Server error' });
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

module.exports = {
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
    verifyReturnExchangeOtp
};
