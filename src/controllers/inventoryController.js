const prisma = require('../../lib/prisma');
const { notifyUser, notifyAdmins, notifyOutlet } = require('../utils/notificationUtils');
const { sendOTP } = require('../services/watiService');
const { logAction } = require('../utils/auditLogger');
const axios = require('axios');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

// ─── Stock Transfer OTP Notification Helper ──────────────────────────────────

async function sendStockTransferOTPNotification(user, otp, recipientType, io = null) {
  const title = 'Stock Transfer OTP';
  const message = `Your Stock Transfer OTP is: ${otp}`;
  const notificationType = 'transfer_otp';
  
  if (user?.id) {
    await notifyUser(user.id, title, message, notificationType, null, io);
  }

  if (!user?.fcm_token) return;

  try {
    await admin.messaging().send({
      token: user.fcm_token,
      notification: { title, body: message },
      data: {
        type: notificationType,
        otp: otp,
        recipient_type: recipientType,
      },
    });
  } catch (fcmError) {
    console.error('FCM send failed for transfer OTP:', fcmError);
  }
}


function roundUpToNearest50(amount) {
    return Math.ceil(amount / 50) * 50;
}

function generateInstallments(categoryName, price) {
    const category = categoryName.toLowerCase().trim();
    let plans = [];

    if (category === 'mobiles' && price <= 50000) {
        plans = [
            { months: 3, profit: 0.20, advance: 0.35 },
            { months: 6, profit: 0.35, advance: 0.25 },
            { months: 9, profit: 0.45, advance: 0.20 },
            { months: 12, profit: 0.55, advance: 0.15 },
        ];
    }
    else if (price > 50000 && price <= 100000) {
        plans = [
            { months: 3, profit: 0.20, advance: 0.40 },
            { months: 6, profit: 0.35, advance: 0.35 },
            { months: 9, profit: 0.45, advance: 0.30 },
            { months: 12, profit: 0.55, advance: 0.25 },
        ];
    }
    else if (price > 100000) {
        plans = [
            { months: 3, profit: 0.20, advance: 0.40 },
            { months: 6, profit: 0.35, advance: 0.35 },
            { months: 9, profit: 0.45, advance: 0.30 },
            { months: 12, profit: 0.55, advance: 0.25 },
            { months: 24, profit: 0.85, advance: 0.25 },
        ];
    }
    else if (price <= 50000) {
        plans = [
            { months: 3, profit: 0.22, advance: 0.40 },
            { months: 6, profit: 0.38, advance: 0.35 },
            { months: 9, profit: 0.48, advance: 0.30 },
            { months: 12, profit: 0.60, advance: 0.25 },
        ];
    } else {
        return [];
    }

    return plans.map(plan => {
        const advanceAmount = roundUpToNearest50(price * plan.advance);
        const remaining = price - advanceAmount;
        const profitAmount = roundUpToNearest50(remaining * plan.profit);
        const totalDealAmount = remaining + profitAmount;
        const monthlyAmount = roundUpToNearest50(totalDealAmount / plan.months);
        const totalPrice = advanceAmount + (monthlyAmount * plan.months);

        return {
            advance: advanceAmount,
            totalPrice: totalPrice,
            monthlyAmount: monthlyAmount,
            months: plan.months,
            isActive: true,
        };
    });
}

const getInventory = async (req, res) => {
    const { outlet_id } = req.user;
    const { page = 1, limit = 20, search = "" } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    if (!outlet_id) {
        return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    }

    try {
        // 1. Get unique product names that match search criteria
        const productSearchWhere = {
            outlet_id,
            OR: search ? [
                { product_name: { contains: search } },
                { imei_serial: { contains: search } },
                { category: { contains: search } }
            ] : undefined
        };

        // Get distinct product names for pagination
        const distinctProducts = await prisma.outletInventory.findMany({
            where: productSearchWhere,
            distinct: ['product_name'],
            select: { product_name: true },
            orderBy: { product_name: 'asc' },
            skip,
            take
        });

        const totalProductsCount = await prisma.outletInventory.groupBy({
            by: ['product_name'],
            where: productSearchWhere,
            _count: true
        });
        const total = totalProductsCount.length;

        const productNames = distinctProducts.map(p => p.product_name);

        // 2. Fetch all records for these product names
        const inventory = await prisma.outletInventory.findMany({
            where: {
                outlet_id,
                product_name: { in: productNames }
            },
            orderBy: [{ product_name: 'asc' }, { id: 'asc' }]
        });

        // 3. Calculate Global Stats
        const statsData = await prisma.outletInventory.aggregate({
            where: { outlet_id },
            _sum: { quantity: true }
        });

        const [inStockCount, soldCount] = await Promise.all([
            prisma.outletInventory.aggregate({
                where: { outlet_id, status: 'In Stock' },
                _sum: { quantity: true }
            }),
            prisma.outletInventory.aggregate({
                where: { outlet_id, status: 'Sold' },
                _sum: { quantity: true }
            })
        ]);

        res.json({ 
            success: true, 
            inventory, // Frontend will group these by product_name
            stats: {
                totalStock: statsData._sum.quantity || 0,
                inStock: inStockCount._sum.quantity || 0,
                sold: soldCount._sum.quantity || 0
            },
            pagination: {
                total, // total unique products
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('getInventory error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const addInventory = async (req, res) => {
    const { outlet_id } = req.user;
    const { items } = req.body;

    if (!outlet_id) {
        return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: 'No items provided.' });
    }

    try {
        const createdItems = [];
        for (const item of items) {
            const { product_name, category, imei_serial, purchase_price, status, color_variant, quantity, installment_plans } = item;

            if (!product_name || purchase_price === undefined) {
                continue;
            }

            const purchasePriceNum = parseFloat(purchase_price);
            
            // If installment_plans are provided in the request (from external API), use them.
            // Otherwise, generate new ones.
            const instPlans = (installment_plans && Array.isArray(installment_plans)) 
                ? installment_plans 
                : generateInstallments(category || '', purchasePriceNum);

            const created = await prisma.outletInventory.create({
                data: {
                    outlet_id,
                    product_name,
                    category: category || '',
                    imei_serial: imei_serial || null,
                    color_variant: color_variant || null,
                    quantity: parseInt(quantity) || 1,
                    purchase_price: purchasePriceNum,
                    installment_price: 0, 
                    installment_plans: instPlans,
                    status: status || 'In Stock'
                }
            });
            createdItems.push(created);
        }

        if (createdItems.length > 0) {
            await logAction(
                req, 
                'STOCK_ADDITION', 
                `Added ${createdItems.length} items to inventory. (First item: ${createdItems[0].product_name})`,
                createdItems[0].id,
                'Inventory'
            );
        }

        res.status(201).json({ success: true, count: createdItems.length, items: createdItems });
    } catch (error) {
        console.error('addInventory error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const initiateStockTransfer = async (req, res) => {
    const { outlet_id } = req.user;
    const { inventory_ids, to_id, to_type } = req.body; // to_type: 'Delivery Officer' | 'Outlet'

    if (!outlet_id || !inventory_ids || !Array.isArray(inventory_ids) || inventory_ids.length === 0 || !to_id || !to_type) {
        return res.status(400).json({ success: false, message: 'Missing fields.' });
    }

    try {
        let recipientIdentifier = '';
        let recipientPhone = '';
        let doUser = null;

        if (to_type === 'Delivery Officer') {
            doUser = await prisma.user.findFirst({
                where: { id: parseInt(to_id), role_id: 2 }
            });
            if (!doUser) return res.status(404).json({ success: false, message: 'Delivery officer not found.' });
            recipientIdentifier = `do_${doUser.id}`;
            recipientPhone = doUser.phone || doUser.whatsapp_number;
        } else if (to_type === 'Outlet') {
            const outlet = await prisma.outlet.findUnique({
                where: { id: parseInt(to_id) }
            });
            if (!outlet) return res.status(404).json({ success: false, message: 'Outlet not found.' });
            if (outlet.id === outlet_id) return res.status(400).json({ success: false, message: 'Cannot transfer stock to the same outlet.' });
            recipientIdentifier = `outlet_${outlet.id}`;
            recipientPhone = outlet.contact_number; // Assuming outlet has contact or we send it to an associated user's app
        } else {
            return res.status(400).json({ success: false, message: 'Invalid transfer type.' });
        }

        // inventory_ids may be [{id, quantity}] objects OR plain integers — normalize both
        const rawIds = inventory_ids.map(i => typeof i === 'object' ? parseInt(i.id) : parseInt(i));

        const items = await prisma.outletInventory.findMany({
            where: { id: { in: rawIds }, outlet_id, status: 'In Stock' }
        });

        if (items.length !== rawIds.length) {
            return res.status(400).json({ success: false, message: 'Some items could not be found or are not in stock.' });
        }

        const otp = Math.floor(10000 + Math.random() * 90000).toString();
        
        await prisma.otp.create({
            data: {
                phone: recipientIdentifier,
                otp,
                purpose: 'stock_transfer',
                expiresAt: new Date(Date.now() + 15 * 60000)
            }
        });

        // Dispatch OTP
        if (to_type === 'Delivery Officer') {
            const message = `Your Stock Transfer OTP is: ${otp}`;
            console.log(`[initiateStockTransfer] Delivery Officer detected. to_id=${to_id}, otp=${otp}`);

            // Save to dedicated OtpLog table
             const otpLog = await prisma.otpLog.create({
                data: {
                    user_id: parseInt(to_id),
                    action: "stock_transfer_otp",
                    message,
                    otp
                }
            });
            console.log(`[initiateStockTransfer] OtpLog created: id=${otpLog.id}`);

            const io = req.app.get('io');
            if (io) {
                const room = `user_${to_id}`;
                const sockets = await io.in(room).fetchSockets();
                console.log(`[initiateStockTransfer] Emitting to room "${room}" - ${sockets.length} connected socket(s)`);
                io.to(room).emit('stock_transfer_otp', {
                    otp_log_id: otpLog.id,
                    action: otpLog.action,
                    message: otpLog.message,
                    otp,
                    created_at: otpLog.created_at
                });
                console.log(`[initiateStockTransfer] ✅ stock_transfer_otp emitted to ${room}`);
            } else {
                console.warn(`[initiateStockTransfer] ⚠️ io is not available on req.app`);
            }

            await sendStockTransferOTPNotification(doUser, otp, 'Delivery Officer', io);
        } else {
    
            // Outlet to Outlet still uses WATI
            if (recipientPhone) {
                await sendOTP(recipientPhone, otp).catch(e => console.error('WATI OTP Error:', e));
            }
        }

        res.json({ success: true, message: `OTP sent successfully to ${to_type}.` });
    } catch (error) {
        console.error('initiateStockTransfer error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const verifyStockTransfer = async (req, res) => {
    const { outlet_id, outlet_name } = req.user;
    const { otp, inventory_ids, to_id, to_type } = req.body;

    if (!outlet_id || !otp || !inventory_ids || !Array.isArray(inventory_ids) || !to_id || !to_type) {
        return res.status(400).json({ success: false, message: 'Missing fields.' });
    }

    try {
        const targetId = parseInt(to_id);
        const phoneKey = to_type === 'Outlet' ? `outlet_${targetId}` : `do_${targetId}`;

        const otpRecord = await prisma.otp.findFirst({
            where: { phone: phoneKey, purpose: 'stock_transfer', isUsed: false },
            orderBy: { createdAt: 'desc' }
        });

        if (!otpRecord || otpRecord.otp !== otp || otpRecord.expiresAt < new Date()) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
        }

        // The new frontend payload should pass inventory_ids as an array of objects: [{ id: 5, quantity: 2 }, ...]
        // We will extract just the IDs to fetch the raw items
        const rawIds = inventory_ids.map(i => typeof i === 'object' ? i.id : i);

        const items = await prisma.outletInventory.findMany({
            where: { id: { in: rawIds }, outlet_id, status: 'In Stock' }
        });

        if (items.length !== rawIds.length) {
            return res.status(400).json({ success: false, message: 'Some items could not be found or are not in stock.' });
        }

        // Process transfers
        const transfers = await prisma.$transaction(async (tx) => {
            const transferData = [];
            
            for (const payloadItem of inventory_ids) {
                const recordId = typeof payloadItem === 'object' ? payloadItem.id : payloadItem;
                const transferQty = typeof payloadItem === 'object' ? (parseInt(payloadItem.quantity) || 1) : 1;

                const item = items.find(i => i.id === recordId);
                if (!item) continue;

                let finalInventoryId = item.id;
                let isFullTransfer = (item.quantity <= transferQty);
                let actualTransferQty = isFullTransfer ? item.quantity : transferQty;

                let targetPayload = { 
                    status: 'Out Of Stock',
                    imei_serial: item.imei_serial || payloadItem.imei_serial || null,
                    color_variant: item.color_variant || payloadItem.color_variant || null
                }; 
                if (to_type === 'Outlet') {
                    targetPayload = { 
                        status: 'In Stock', 
                        outlet_id: targetId,
                        imei_serial: item.imei_serial || payloadItem.imei_serial || null,
                        color_variant: item.color_variant || payloadItem.color_variant || null
                    };
                }

                if (isFullTransfer) {
                    await tx.outletInventory.update({
                        where: { id: item.id },
                        data: targetPayload
                    });
                } else {
                    // Split the row! Keep original at original outlet with reduced Qty
                    await tx.outletInventory.update({
                        where: { id: item.id },
                        data: { quantity: item.quantity - actualTransferQty }
                    });

                    // Merge or create for the Target Outlet
                    const targetOutletId = (to_type === 'Outlet') ? targetId : outlet_id;
                    const existingAtTarget = await tx.outletInventory.findFirst({
                        where: {
                            outlet_id: targetOutletId,
                            product_name: item.product_name,
                            status: 'In Stock'
                        }
                    });

                    if (existingAtTarget) {
                        const updated = await tx.outletInventory.update({
                            where: { id: existingAtTarget.id },
                            data: {
                                quantity: existingAtTarget.quantity + actualTransferQty,
                                status: 'In Stock'
                            }
                        });
                        finalInventoryId = updated.id;
                    } else {
                        const cloned = await tx.outletInventory.create({
                            data: {
                                outlet_id: targetOutletId,
                                product_name: item.product_name,
                                category: item.category,
                                imei_serial: item.imei_serial || payloadItem.imei_serial || null,
                                color_variant: item.color_variant || payloadItem.color_variant || null,
                                quantity: actualTransferQty,
                                purchase_price: item.purchase_price,
                                installment_price: item.installment_price,
                                status: 'In Stock'
                            }
                        });
                        finalInventoryId = cloned.id;
                    }
                }

                transferData.push({
                    from_type: 'Outlet',
                    from_id: outlet_id,
                    to_type,
                    to_id: targetId,
                    inventory_id: finalInventoryId,
                    quantity_transferred: actualTransferQty
                });
            }

            // Bulk create transfer records
            await tx.stockTransfer.createMany({
                data: transferData
            });

            // Mark OTP as used
            await tx.otp.update({
                where: { id: otpRecord.id },
                data: { isUsed: true }
            });

            return transferData; 
        }, { timeout: 15000 }); 

        // Notifications
        const messageTitle = 'Stock Transfer Received';
        const messageBody = `You have received a transfer of ${transfers.length} item entry(s) from Outlet ${outlet_id}.`;
        const io = req.app.get('io');

        if (to_type === 'Delivery Officer') {
            await notifyUser(targetId, messageTitle, messageBody, 'stock_transfer', null, io);
        } else if (to_type === 'Outlet') {
            await notifyOutlet(targetId, messageTitle, messageBody, 'stock_transfer', null, io);
        }

        // Notify Admins mapping (dashboard global alerts)
        await notifyAdmins('Outlet Stock Transferred', `${transfers.length} item batches transferred from Outlet ${outlet_id} to ${to_type} ${targetId}`, 'stock_transfer', null, io);

        res.json({ success: true, transfers });
    } catch (error) {
        console.error('verifyStockTransfer error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getTransferHistory = async (req, res) => {
    const { outlet_id } = req.user;
    const { page = 1, limit = 20, search = "" } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    if (!outlet_id) {
        return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    }

    try {
        const where = { 
            from_type: 'Outlet', 
            from_id: outlet_id,
            OR: search ? [
                { inventory: { product_name: { contains: search } } },
                { inventory: { imei_serial: { contains: search } } }
            ] : undefined
        };

        const [transfers, total] = await Promise.all([
            prisma.stockTransfer.findMany({
                where,
                include: {
                    inventory: {
                        select: {
                            id: true,
                            product_name: true,
                            category: true,
                            color_variant: true,
                            imei_serial: true,
                            quantity: true,
                            purchase_price: true,
                            status: true
                        }
                    }
                },
                orderBy: { created_at: 'desc' },
                skip,
                take
            }),
            prisma.stockTransfer.count({ where })
        ]);

        // Map to_id to human readable names
        const deliveryToIds = [...new Set(transfers.filter(t => t.to_type === 'Delivery Officer').map(t => t.to_id))];
        const outletToIds = [...new Set(transfers.filter(t => t.to_type === 'Outlet').map(t => t.to_id))];

        const [deliveryOfficers, outlets] = await Promise.all([
            prisma.user.findMany({
                where: { id: { in: deliveryToIds } },
                select: { id: true, full_name: true, username: true }
            }),
            prisma.outlet.findMany({
                where: { id: { in: outletToIds } },
                select: { id: true, name: true, address: true }
            })
        ]);

        const mappedTransfers = transfers.map(t => {
            let recipientName = 'Unknown';
            if (t.to_type === 'Delivery Officer') {
                const off = deliveryOfficers.find(o => o.id === t.to_id);
                if (off) recipientName = `${off.full_name} (${off.username})`;
            } else if (t.to_type === 'Outlet') {
                const out = outlets.find(o => o.id === t.to_id);
                if (out) recipientName = `${out.name} (${out.address || 'No Address'})`;
            }

            return {
                ...t,
                recipient_name: recipientName
            };
        });

        res.json({ 
            success: true, 
            count: mappedTransfers.length, 
            transfers: mappedTransfers,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('getTransferHistory error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const updateInventoryItem = async (req, res) => {
    const { outlet_id } = req.user;
    const { id } = req.params;
    const data = req.body;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Unauthorized' });

    try {
        const updated = await prisma.outletInventory.updateMany({
            where: { id: parseInt(id), outlet_id },
            data: {
                product_name: data.product_name,
                category: data.category,
                imei_serial: data.imei_serial,
                color_variant: data.color_variant,
                quantity: data.quantity !== undefined ? parseInt(data.quantity) : undefined,
                purchase_price: data.purchase_price !== undefined ? parseFloat(data.purchase_price) : undefined,
                status: data.status,
            }
        });

        if (updated.count === 0) return res.status(404).json({ success: false, message: 'Item not found' });
        
        res.json({ success: true, message: 'Item updated successfully' });
    } catch (error) {
        console.error('Update item err:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const deleteInventoryItem = async (req, res) => {
    const { outlet_id } = req.user;
    const { id } = req.params;

    try {
        const deleted = await prisma.outletInventory.deleteMany({
            where: { id: parseInt(id), outlet_id }
        });

        if (deleted.count === 0) return res.status(404).json({ success: false, message: 'Item not found' });
        
        res.json({ success: true, message: 'Item deleted successfully' });
    } catch (error) {
        console.error('Delete item err:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const bulkUpdateInventory = async (req, res) => {
    const { outlet_id } = req.user;
    const { ids, data } = req.body;

    if (!outlet_id || !Array.isArray(ids) || ids.length === 0 || !data) {
        return res.status(400).json({ success: false, message: 'Invalid payload' });
    }

    try {
        let updateData = {};
        if (data.status) updateData.status = data.status;
        if (data.product_name) updateData.product_name = data.product_name;
        if (data.category) updateData.category = data.category;
        if (data.color_variant) updateData.color_variant = data.color_variant;
        if (data.quantity !== undefined) updateData.quantity = parseInt(data.quantity);
        if (data.purchase_price !== undefined) updateData.purchase_price = parseFloat(data.purchase_price);

        const updated = await prisma.outletInventory.updateMany({
            where: { id: { in: ids.map(id => parseInt(id)) }, outlet_id },
            data: updateData
        });

        res.json({ success: true, count: updated.count, message: 'Items updated successfully' });
    } catch (error) {
        console.error('Bulk update err:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const bulkDeleteInventory = async (req, res) => {
    const { outlet_id } = req.user;
    const { ids } = req.body;

    if (!outlet_id || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: 'Invalid payload' });
    }

    try {
        const deleted = await prisma.outletInventory.deleteMany({
            where: { id: { in: ids.map(id => parseInt(id)) }, outlet_id }
        });

        res.json({ success: true, count: deleted.count, message: 'Items deleted successfully' });
    } catch (error) {
        console.error('Bulk delete err:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

module.exports = {
    getInventory,
    addInventory,
    initiateStockTransfer,
    verifyStockTransfer,
    getTransferHistory,
    updateInventoryItem,
    deleteInventoryItem,
    bulkUpdateInventory,
    bulkDeleteInventory,
    generateInstallments
};
