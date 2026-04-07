const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwtConfig');
const bcrypt = require('bcrypt');
const { updateCashRegister } = require('../utils/cashRegisterUtils');
const { sendOTP } = require('../services/watiService');


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

        // Step 2: Time calculation for Used Stock logic (48 hours)
        const deliveryTime = record.order.delivery?.end_time || record.order.delivery?.updated_at || record.order.updated_at;
        const now = new Date();
        const hoursSinceDelivery = (now.getTime() - new Date(deliveryTime).getTime()) / (1000 * 60 * 60);
        
        // If type is Return and > 48h, mark as Used
        const isUsed = record.type === 'Return' && hoursSinceDelivery > 48;

        // Step 3: Mark return record as verified
        const updatedRecord = await prisma.returnExchange.update({
            where: { id: record.id },
            data: {
                status: 'verified',
                verified_at: now,
                is_used: isUsed
            }
        });

        // Step 4: Handle Cash Refund (Cash Register impact)
        if (record.is_cash_refund && record.refund_amount > 0) {
            await updateCashRegister(null, parseInt(outlet_id), 'expenses', record.refund_amount, 'add');
        }

        // Step 5: Handle CashInHand Cancellation for Delivery Officer
        // If there's a pending cash collection for this order, cancel it since the product is returned.
        const pendingCash = await prisma.cashInHand.findFirst({
            where: {
                order_id: record.order_id,
                status: 'pending'
            }
        });

        if (pendingCash) {
            await prisma.cashInHand.update({
                where: { id: pendingCash.id },
                data: { status: 'cancelled' } // Mark as cancelled instead of paid
            });
        }

        // Step 6: Change order status & Handle Exchange
        const isExchange = record.type === 'Exchange';
        
        if (isExchange) {
            // For Exchange: Reset the order so it can be delivered again
            await prisma.order.update({
                where: { id: record.order_id },
                data: {
                    status: 'approved',
                    imei_serial: null,
                    is_delivered: false
                }
            });

            // Delete the delivery record (remove delivery history for this attempt)
            await prisma.delivery.deleteMany({
                where: { order_id: record.order_id }
            });

            console.log(`Exchange completed: Order ${record.order.order_ref} reset to approved for redelivery.`);
        } else {
            // Simple Return
            await prisma.order.update({
                where: { id: record.order_id },
                data: {
                    status: 'Returned',
                    imei_serial: null,
                    is_delivered: false
                }
            });
        }

        // Step 7: Update inventory status
        if (record.imei_returned) {
            const inventory = await prisma.outletInventory.findFirst({
                where: { imei_serial: record.imei_returned, outlet_id: parseInt(outlet_id) }
            });

            if (inventory) {
                await prisma.outletInventory.update({
                    where: { id: inventory.id },
                    data: { status: isUsed ? 'Used Stock' : 'In Stock' }
                });

                // Step 8: Log the stock transfer
                await prisma.stockTransfer.create({
                    data: {
                        inventory_id: inventory.id,
                        from_type: 'Customer',
                        from_id: record.order_id,
                        to_type: 'Outlet',
                        to_id: parseInt(outlet_id),
                        status: 'completed',
                        quantity_transferred: 1,
                    }
                });
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
    const { order_id, type, is_cash_refund, refund_amount } = req.body;

    if (!order_id || !['Return', 'Exchange'].includes(type)) {
        return res.status(400).json({ success: false, error: 'Valid order_id and type (Return/Exchange) are required.' });
    }

    try {
        // 1. Fetch order, delivery, verification, and the official CashInHand receipt
        const order = await prisma.order.findUnique({
            where: { id: parseInt(order_id) },
            include: { 
                delivery: true,
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

        // 2. Extract delivery-specific data prioritizing the official CashInHand record
        const cashRecord = order.cash_in_hand?.[0];
        const deliveryPlan = order.delivery.selected_plan ? (typeof order.delivery.selected_plan === 'string' ? JSON.parse(order.delivery.selected_plan) : order.delivery.selected_plan) : null;
        
        const deliveredAdvance = cashRecord ? cashRecord.amount : (deliveryPlan?.advance_payment || deliveryPlan?.advance_amount || deliveryPlan?.advancePayment || order.advance_amount);
        const productName = cashRecord?.product_name || deliveryPlan?.productName || order.product_name;
        const imei = cashRecord?.imei_serial || order.delivery.product_imei;

        // Split color/variant from CashInHand snapshot first
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

        // 3. Generate OTP for customer verification
        const otp = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit OTP

        // 4. Create PENDING record (Storing extra specs in selected_plan JSON to avoid schema conflicts)
        const returnRecord = await prisma.returnExchange.create({
            data: {
                order_id: parseInt(order_id),
                outlet_id: outlet_id,
                type: type,
                status: 'pending',
                otp: otp,
                product_name: productName,
                // We store these in selected_plan to ensure data is captured without needing immediate schema columns
                selected_plan: {
                    ...deliveryPlan,
                    delivered_color: color,
                    delivered_variant: variant,
                    delivered_advance_amount: parseFloat(deliveredAdvance) || 0
                },
                imei_returned: imei,
                is_cash_refund: !!is_cash_refund,
                refund_amount: parseFloat(refund_amount) || 0,
                initiated_by: "Outlet"
            }
        });

        // 5. Send OTP to Customer (Purchaser) via WhatsApp
        const customerPhone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
        
        if (customerPhone) {
            try {
                await sendOTP(customerPhone, otp);
                console.log(`Sales Return OTP ${otp} sent to customer at ${customerPhone}`);
            } catch (err) {
                console.error('Error sending Sales Return OTP to customer:', err);
            }
        }

        // 6. Socket Notification for Real-time Dashboard Update
        const io = req.app.get('io');
        if (io) {
            io.to(`outlet_${outlet_id}`).emit('return_exchange_requested', {
                record_id: returnRecord.id,
                officer_name: "Outlet",
                type,
                otp,
                order_ref: order.order_ref,
                product_name: productName,
                color: color,
                variant: variant,
                delivered_advance: deliveredAdvance,
                imei: imei || null,
                is_cash_refund: returnRecord.is_cash_refund,
                refund_amount: returnRecord.refund_amount
            });
        }

        return res.json({ 
            success: true, 
            message: `OTP generated and sent to customer's WhatsApp. Please verify to complete the Sales Return.`, 
            data: { record_id: returnRecord.id } 
        });

    } catch (error) {
        console.error('initiateDirectReturn error:', error);
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
        const orders = await prisma.order.findMany({
            where: {
                outlet_id: outlet_id,
                delivery: { status: 'completed' },
                OR: [
                    { order_ref: { contains: query } },
                    { customer_name: { contains: query } },
                    { product_name: { contains: query } },
                    { 
                        delivery: { 
                            product_imei: { contains: query } 
                        } 
                    }
                ]
            },
            include: { 
                delivery: true,
                cash_in_hand: {
                    take: 1,
                    orderBy: { created_at: 'desc' }
                }
            },
            take: 10
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
                delivered_advance: deliveredAdvance
            };
        });

        return res.json({ success: true, data: refinedOrders });
    } catch (error) {
        console.error('searchDeliveredOrders error:', error);
        return res.status(500).json({ success: false, error: 'Server error' });
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
    verifyReturnExchangeOtp,
    initiateDirectReturn,
    searchDeliveredOrders
};
