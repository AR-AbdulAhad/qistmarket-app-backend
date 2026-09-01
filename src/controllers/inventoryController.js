const prisma = require('../../lib/prisma');
const { notifyUser, notifyAdmins, notifyOutlet } = require('../utils/notificationUtils');
const { sendOtp: sendOTP } = require('../services/otpDispatcher');
const { logAction } = require('../utils/auditLogger');
const { logOrderStatusChange } = require('../utils/orderAuditLogger');
const axios = require('axios');
const admin = require('firebase-admin');

// ─── Firebase Init ────────────────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
// ─────────────────────────────────────────────────────────────────

// Helper for current timestamp
const now = () => new Date();


// ─── Stock Transfer OTP Notification Helper ──────────────────────────────────

async function sendStockTransferOTPNotification(user, otp, recipientType, io = null) {
    const title = 'Stock Transfer OTP';
    const message = `Your Stock Transfer OTP is: ${otp}`;
    const notificationType = 'stock_transfer_otp';

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

    if (category === 'mobiles' && price <= 60000) {
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
            { months: 24, profit: 0.85, advance: 0.25 },
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
            { months: 24, profit: 0.85, advance: 0.25 },
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

// Strips everything but letters/digits and lowercases, so "8/256", "8 256", "8-256" and
// "8GB/256GB" all collapse to a comparable form. SQL `contains` is brittle against exactly
// this kind of formatting drift between what's displayed and what a user types or pastes
// (different spacing, slashes, casing), so matching is done in JS on the normalized strings
// instead of relying on the database's LIKE semantics.
function normalizeForSearch(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// True if every row field, concatenated and normalized, contains the normalized search text
// as a substring — immune to spacing/punctuation/case differences between the two.
function matchesSearch(row, search, fields) {
    const normalizedSearch = normalizeForSearch(search);
    if (!normalizedSearch) return true;
    const haystack = normalizeForSearch(fields.map(f => row[f]).filter(Boolean).join(' '));
    return haystack.includes(normalizedSearch);
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
        // Exclude 'Pending Transfer' items — they are tracked in transfer history, not inventory list
        const productSearchWhere = {
            outlet_id,
            is_used: false,
            status: { not: 'Used Stock' },
        };

        // Fetch every row for this outlet — a product's real "quantity" is the
        // SUM of its rows' `quantity` field, not the row count (a bulk row can hold
        // quantity > 1 on its own). Sorting/paginating by row count breaks ranking for
        // those, so instead we group + rank in JS across the FULL set first, then
        // paginate the already-globally-sorted product groups. Search matching also
        // happens in JS (see matchesSearch) rather than in the SQL query.
        const allRows = await prisma.outletInventory.findMany({
            where: productSearchWhere,
            orderBy: [{ product_name: 'asc' }, { id: 'asc' }]
        });
        const allMatchingRows = allRows.filter(row =>
            matchesSearch(row, search, ['product_name', 'imei_serial', 'category', 'color_variant'])
        );

        const groupMap = new Map();
        for (const row of allMatchingRows) {
            let grp = groupMap.get(row.product_name);
            if (!grp) {
                grp = { product_name: row.product_name, inStockQty: 0 };
                groupMap.set(row.product_name, grp);
            }
            if (row.status === 'In Stock' || row.status === 'Used Stock') {
                grp.inStockQty += row.quantity || 0;
            }
        }

        // Same ordering rule the UI uses: any in-stock qty first (highest first), zero-stock products last.
        const sortedGroups = Array.from(groupMap.values()).sort((a, b) => {
            if (b.inStockQty === 0 && a.inStockQty > 0) return -1;
            if (a.inStockQty === 0 && b.inStockQty > 0) return 1;
            return b.inStockQty - a.inStockQty;
        });

        const total = sortedGroups.length;
        const productNames = sortedGroups.slice(skip, skip + take).map(g => g.product_name);
        const productNameSet = new Set(productNames);

        // 2. Rows for just this page's products, preserving the global rank order.
        const rowsByProduct = new Map();
        for (const row of allMatchingRows) {
            if (!productNameSet.has(row.product_name)) continue;
            if (!rowsByProduct.has(row.product_name)) rowsByProduct.set(row.product_name, []);
            rowsByProduct.get(row.product_name).push(row);
        }
        const inventory = productNames.flatMap(name => rowsByProduct.get(name) || []);

        // 3. Calculate Global Stats (Exact total count instead of unique product count)
        const [totalStock, inStock, sold, outOfStock] = await Promise.all([
            prisma.outletInventory.count({
                where: { outlet_id, is_used: false, status: { not: 'Used Stock' } }
            }),
            prisma.outletInventory.count({
                where: { outlet_id, is_used: false, status: 'In Stock' }
            }),
            prisma.outletInventory.count({
                where: { outlet_id, is_used: false, status: 'Sold' }
            }),
            prisma.outletInventory.count({
                where: { outlet_id, is_used: false, status: 'Out Of Stock' }
            })
        ]);

        res.json({
            success: true,
            inventory, // Frontend will group these by product_name
            stats: {
                totalStock: totalStock || 0,
                inStock: inStock || 0,
                sold: sold || 0,
                outOfStock: outOfStock || 0
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

const getStockTransferInventory = async (req, res) => {
    const { outlet_id } = req.user;
    const { page = 1, limit = 20, search = "" } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    if (!outlet_id) {
        return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    }

    try {
        // 1. Get unique product names that match search criteria
        // Exclude 'Pending Transfer' items — they are tracked in transfer history, not inventory list
        const allOutletRows = await prisma.outletInventory.findMany({
            where: { outlet_id },
            orderBy: [{ product_name: 'asc' }, { id: 'asc' }]
        });
        const matchingRows = allOutletRows.filter(row =>
            matchesSearch(row, search, ['product_name', 'imei_serial', 'category', 'color_variant'])
        );

        // Get products ordered by stock count descending for pagination
        const countByProduct = new Map();
        for (const row of matchingRows) {
            countByProduct.set(row.product_name, (countByProduct.get(row.product_name) || 0) + 1);
        }
        const sortedProductNames = Array.from(countByProduct.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([name]) => name);

        const total = sortedProductNames.length;
        const productNames = sortedProductNames.slice(skip, skip + take);

        // 2. Fetch all records for these product names (excluding Pending Transfer)
        const inventory = await prisma.outletInventory.findMany({
            where: {
                outlet_id,
                product_name: { in: productNames }
            },
            orderBy: [{ product_name: 'asc' }, { id: 'asc' }]
        });

        // 3. Calculate Global Stats (Exact total count instead of unique product count)
        const [totalStock, inStock, sold, outOfStock] = await Promise.all([
            prisma.outletInventory.count({
                where: { outlet_id }
            }),
            prisma.outletInventory.count({
                where: { outlet_id, status: 'In Stock' }
            }),
            prisma.outletInventory.count({
                where: { outlet_id, status: 'Sold' }
            }),
            prisma.outletInventory.count({
                where: { outlet_id, status: 'Out Of Stock' }
            })
        ]);

        res.json({
            success: true,
            inventory, // Frontend will group these by product_name
            stats: {
                totalStock: totalStock || 0,
                inStock: inStock || 0,
                sold: sold || 0,
                outOfStock: outOfStock || 0
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


const getUsedInventory = async (req, res) => {
    const { outlet_id } = req.user;
    const { page = 1, limit = 20, search = "" } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    if (!outlet_id) {
        return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    }

    try {
        const allUsedRows = await prisma.outletInventory.findMany({
            where: { outlet_id, is_used: true },
            orderBy: [{ product_name: 'asc' }, { id: 'asc' }]
        });
        const matchingUsedRows = allUsedRows.filter(row =>
            matchesSearch(row, search, ['product_name', 'imei_serial', 'category', 'color_variant'])
        );

        const countByProduct = new Map();
        for (const row of matchingUsedRows) {
            countByProduct.set(row.product_name, (countByProduct.get(row.product_name) || 0) + 1);
        }
        const sortedProductNames = Array.from(countByProduct.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([name]) => name);

        const total = sortedProductNames.length;
        const productNames = sortedProductNames.slice(skip, skip + take);

        const inventory = await prisma.outletInventory.findMany({
            where: {
                outlet_id,
                is_used: true,
                product_name: { in: productNames }
            },
            orderBy: [{ product_name: 'asc' }, { id: 'asc' }]
        });

        const [totalStockCount, inStockCount, soldCount, outOfStockCount] = await Promise.all([
            prisma.outletInventory.count({
                where: { outlet_id, is_used: true }
            }),
            prisma.outletInventory.count({
                where: { outlet_id, is_used: true, status: { in: ['In Stock', 'Used Stock'] } }
            }),
            prisma.outletInventory.count({
                where: { outlet_id, is_used: true, status: 'Sold' }
            }),
            prisma.outletInventory.count({
                where: { outlet_id, is_used: true, status: 'Out Of Stock' }
            })
        ]);

        res.json({
            success: true,
            inventory,
            stats: {
                totalStock: totalStockCount || 0,
                inStock: inStockCount || 0,
                sold: soldCount || 0,
                outOfStock: outOfStockCount || 0
            },
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('getUsedInventory error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getUsedInventoryReversalHistory = async (req, res) => {
    const { outlet_id } = req.user;
    const { page = 1, limit = 20, search = "" } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    if (!outlet_id) {
        return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    }

    try {
        const where = {
            inventory: { outlet_id },
            status: 'Used Stock Reversed',
            OR: search ? [
                { inventory: { product_name: { contains: search } } },
                { inventory: { imei_serial: { contains: search } } },
            ] : undefined,
        };

        const [history, total] = await Promise.all([
            prisma.stockTransfer.findMany({
                where,
                include: {
                    inventory: {
                        select: {
                            id: true,
                            product_name: true,
                            imei_serial: true,
                            category: true,
                            color_variant: true,
                            purchase_price: true,
                        }
                    }
                },
                orderBy: { created_at: 'desc' },
                skip,
                take,
            }),
            prisma.stockTransfer.count({ where }),
        ]);

        res.json({
            success: true,
            history: history.map(item => ({
                id: item.id,
                inventory_id: item.inventory_id,
                product_name: item.inventory?.product_name || 'Unknown',
                imei_serial: item.inventory?.imei_serial || null,
                category: item.inventory?.category || null,
                color_variant: item.inventory?.color_variant || null,
                purchase_price: item.inventory?.purchase_price || 0,
                status: item.status,
                created_at: item.created_at,
                updated_at: item.updated_at,
            })),
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit)),
            },
        });
    } catch (error) {
        console.error('getUsedInventoryReversalHistory error:', error);
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

            // Mobiles/Laptops are handed over as one specific physical unit at
            // delivery (self-pickup/agent delivery both need a real IMEI/serial
            // to record against the order and, for phones, to gate PayTrigger
            // enrollment) — so a serial-less row here silently becomes
            // unpickable stock later. Other categories (accessories, generic
            // goods) aren't individually tracked, so they stay optional.
            const categoryLower = (category || '').toLowerCase();
            const requiresSerial = categoryLower === 'mobiles' || categoryLower === 'laptops';
            if (requiresSerial && (!imei_serial || imei_serial.trim() === '')) {
                return res.status(400).json({
                    success: false,
                    message: `IMEI/Serial is required for ${category} — "${product_name}" was not added.`
                });
            }

            const purchasePriceNum = parseFloat(purchase_price);

            // Check for duplicate IMEI system-wide
            if (imei_serial && imei_serial.trim() !== '') {
                const duplicate = await prisma.outletInventory.findFirst({
                    where: { imei_serial: imei_serial.trim() }
                });
                if (duplicate) {
                    return res.status(400).json({
                        success: false,
                        message: `IMEI/Serial ${imei_serial} already exists.`
                    });
                }
            }

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
                    status: status || 'In Stock',
                    created_at: now(),   // ✅ explicit created_at
                    updated_at: now()    // ✅ explicit updated_at
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

    const targetId = parseInt(to_id);

    try {
        let recipientIdentifier = '';
        let recipientPhone = '';
        let recipientName = '';
        let doUser = null;
        let targetOutlet = null;

        if (to_type === 'Outlet') {
            targetOutlet = await prisma.outlet.findUnique({ where: { id: targetId } });
            if (!targetOutlet) return res.status(404).json({ success: false, message: 'Target outlet not found.' });
            if (targetOutlet.id === outlet_id) return res.status(400).json({ success: false, message: 'Cannot transfer to same outlet.' });
            recipientIdentifier = `outlet_${targetId}`;
            recipientName = targetOutlet.name;
            // Assuming outlets have a contact phone or we use a manager's phone. 
            // For now, let's look for any user in that outlet to get a phone number for WATI if needed.
            const outletManager = await prisma.user.findFirst({ where: { outlet_id: targetId, role_id: 4 } }); // Role 4 = Outlet Manager?
            recipientPhone = outletManager?.phone || outletManager?.whatsapp_number || '';
        } else if (to_type === 'Delivery Officer') {
            doUser = await prisma.user.findFirst({ where: { id: targetId, role_id: 2 } });
            if (!doUser) return res.status(404).json({ success: false, message: 'Delivery officer not found.' });
            recipientIdentifier = `do_${targetId}`;
            recipientName = doUser.full_name;
            recipientPhone = doUser.phone || doUser.whatsapp_number;
        } else {
            return res.status(400).json({ success: false, message: 'Invalid transfer type.' });
        }

        // Normalize inventory IDs
        const rawIds = inventory_ids.map(i => typeof i === 'object' ? parseInt(i.id) : parseInt(i));

        // Fetch items and mark as Pending Transfer
        const items = await prisma.outletInventory.findMany({
            where: { id: { in: rawIds }, outlet_id, status: 'In Stock' }
        });

        if (items.length !== rawIds.length) {
            return res.status(400).json({ success: false, message: 'Some items could not be found or are not in stock.' });
        }

        // ── Duplicate IMEI conflict check ───────────────────────────────────────
        // Check if any selected IMEI already has an active pending transfer
        const imeiItems = items.filter(i => i.imei_serial && i.imei_serial.trim() !== '');
        if (imeiItems.length > 0) {
            const conflictingTransfers = await prisma.stockTransfer.findMany({
                where: {
                    inventory_id: { in: imeiItems.map(i => i.id) },
                    status: 'pending'
                },
                include: { inventory: { select: { imei_serial: true, product_name: true } } }
            });
            if (conflictingTransfers.length > 0) {
                return res.status(409).json({
                    success: false,
                    conflict: true,
                    conflicting_imeis: conflictingTransfers.map(c => ({
                        transfer_id: c.id,
                        imei: c.inventory?.imei_serial || 'N/A',
                        product_name: c.inventory?.product_name || 'Unknown'
                    })),
                    message: 'Some selected items already have active pending transfers.'
                });
            }
        }
        // ────────────────────────────────────────────────────────────────────────

        const otp = Math.floor(10000 + Math.random() * 90000).toString();

        const result = await prisma.$transaction(async (tx) => {
            // 1. Create OTP with explicit timestamps
            await tx.otp.create({
                data: {
                    phone: recipientIdentifier,
                    otp,
                    purpose: 'stock_transfer',
                    expiresAt: new Date(Date.now() + 15 * 60000),
                    createdAt: now(),   // ✅ explicit createdAt
                    updatedAt: now()    // ✅ explicit updatedAt
                }
            });

            const transferRecordsToCreate = [];

            // 2. Process each item (with row splitting if needed)
            for (const payloadItem of inventory_ids) {
                const recordId = typeof payloadItem === 'object' ? parseInt(payloadItem.id) : parseInt(payloadItem);
                const requestedQty = typeof payloadItem === 'object' ? (parseInt(payloadItem.quantity) || 1) : 1;

                const item = await tx.outletInventory.findUnique({
                    where: { id: recordId, outlet_id, status: 'In Stock' }
                });

                if (!item || item.quantity < requestedQty) {
                    throw new Error(`Item ${recordId} not found or insufficient quantity.`);
                }

                let finalInventoryId = item.id;

                if (requestedQty < item.quantity) {
                    // SPLIT ROW: Create a new row for the pending transfer
                    const newPendingRow = await tx.outletInventory.create({
                        data: {
                            outlet_id: item.outlet_id,
                            product_name: item.product_name,
                            category: item.category,
                            imei_serial: item.imei_serial,
                            purchase_price: item.purchase_price,
                            installment_price: item.installment_price,
                            status: 'Pending Transfer',
                            color_variant: item.color_variant,
                            quantity: requestedQty,
                            installment_plans: item.installment_plans,
                            created_at: now(),   // ✅ explicit
                            updated_at: now()    // ✅ explicit
                        }
                    });

                    // Update original row (reduce quantity) with updated_at
                    await tx.outletInventory.update({
                        where: { id: item.id },
                        data: { 
                            quantity: item.quantity - requestedQty,
                            updated_at: now()   // ✅ explicit updated_at
                        }
                    });

                    finalInventoryId = newPendingRow.id;
                } else {
                    // FULL ROW: Just mark as Pending Transfer with updated_at
                    await tx.outletInventory.update({
                        where: { id: item.id },
                        data: { 
                            status: 'Pending Transfer',
                            updated_at: now()   // ✅ explicit updated_at
                        }
                    });
                }

                transferRecordsToCreate.push({
                    from_type: 'Outlet',
                    from_id: outlet_id,
                    to_type,
                    to_id: targetId,
                    inventory_id: finalInventoryId,
                    quantity_transferred: requestedQty,
                    status: 'pending',
                    created_at: now(),   // ✅ explicit created_at
                    updated_at: now()    // ✅ explicit updated_at
                });
            }

            // 3. Create StockTransfer records
            await tx.stockTransfer.createMany({ data: transferRecordsToCreate });

            return { otp };
        });

        // Notifications & Sockets
        const io = req.app.get('io');
        const message = `Stock Transfer OTP: ${otp}. From Outlet ${outlet_id} to ${to_type} ${recipientName}`;

        // Log OTP with explicit created_at
        await prisma.otpLog.create({
            data: {
                user_id: to_type === 'Delivery Officer' ? parseInt(targetId) : req.user.id,
                action: "stock_transfer_otp",
                message,
                otp,
                created_at: now()   // ✅ explicit created_at
            }
        });

        if (io) {
            // Notify Receiver
            const receiverRoom = to_type === 'Delivery Officer' ? `user_${targetId}` : `outlet_${targetId}`;
            io.to(receiverRoom).emit('stock_transfer_initiated', {
                from_id: outlet_id,
                from_name: req.user.outlet_name || `Outlet ${outlet_id}`,
                items_count: items.length,
                items: items.map(i => ({ name: i.product_name, imei: i.imei_serial })),
                otp: otp, // Sending OTP via socket for the popup
                to_type
            });

            // Notify Sender
            const senderRoom = `outlet_${outlet_id}`;
            io.to(senderRoom).emit('stock_transfer_status', {
                status: 'initiated',
                to_name: recipientName,
                items_count: rawIds.length
            });

            // Specific event for Mobile App (Delivery Officer)
            if (to_type === 'Delivery Officer') {
                const appRoom = `user_${targetId}`;
                io.to(appRoom).emit('stock_transfer_otp', {
                    action: "stock_transfer_otp",
                    message,
                    otp,
                    created_at: now()
                });
            }
        }

        // Send OTP via external services if available
        if (recipientPhone) {
            await sendOTP(recipientPhone, otp).catch(e => console.error('OTP Service Error:', e));
        }

        // Send FCM Notification for Mobile App (pass null for io to avoid duplicate socket event)
        const recipientUser = to_type === 'Delivery Officer' ? doUser :
            await prisma.user.findFirst({ where: { outlet_id: targetId, role_id: 4 } });

        if (recipientUser) {
            await sendStockTransferOTPNotification(recipientUser, otp, to_type, null).catch(e => console.error('FCM Notification Error:', e));
        }

        const itemsDetail = items.map(i => `${i.product_name} (${i.imei_serial || 'No IMEI'})`).join(', ');
        await logAction(req, 'STOCK_TRANSFER_INITIATED', `Initiated transfer of items to ${to_type} ${recipientName}: ${itemsDetail}`, null, 'Inventory');

        res.json({ success: true, message: `OTP sent successfully to ${to_type}.`, otp_sent: true });
    } catch (error) {
        console.error('initiateStockTransfer error:', error);
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
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

        // Normalize inventory IDs
        const rawIds = inventory_ids.map(i => typeof i === 'object' ? i.id : i);

        // Fetch items that are in 'Pending Transfer' status at the origin outlet
        const items = await prisma.outletInventory.findMany({
            where: { id: { in: rawIds }, outlet_id }
        });

        if (items.length !== rawIds.length) {
            return res.status(400).json({
                success: false,
                message: 'Some items could not be found or do not belong to this outlet.'
            });
        }

        // Process transfers
        const transfers = await prisma.$transaction(async (tx) => {
            const transferData = [];

            for (const payloadItem of inventory_ids) {
                const recordId = typeof payloadItem === 'object' ? payloadItem.id : payloadItem;
                const transferQty = typeof payloadItem === 'object' ? (parseInt(payloadItem.quantity) || 1) : 1;

                const item = items.find(i => i.id === recordId);
                if (!item) continue;

                let isFullTransfer = (item.quantity <= transferQty);
                let actualTransferQty = isFullTransfer ? item.quantity : transferQty;

                if (to_type === 'Outlet') {
                    if (isFullTransfer) {
                        // Full row moves to target outlet
                        await tx.outletInventory.update({
                            where: { id: item.id },
                            data: { 
                                outlet_id: targetId, 
                                status: 'In Stock',
                                updated_at: now()   // ✅ explicit updated_at
                            }
                        });
                    } else {
                        // Split row: Original stays at origin with reduced Qty, new row created at target
                        await tx.outletInventory.update({
                            where: { id: item.id },
                            data: { 
                                quantity: item.quantity - actualTransferQty, 
                                status: 'In Stock',
                                updated_at: now()   // ✅ explicit updated_at
                            }
                        });

                        const existingAtTarget = await tx.outletInventory.findFirst({
                            where: { outlet_id: targetId, product_name: item.product_name, status: 'In Stock' }
                        });

                        if (existingAtTarget) {
                            await tx.outletInventory.update({
                                where: { id: existingAtTarget.id },
                                data: { 
                                    quantity: existingAtTarget.quantity + actualTransferQty,
                                    updated_at: now()   // ✅ explicit updated_at
                                }
                            });
                        } else {
                            await tx.outletInventory.create({
                                data: {
                                    outlet_id: targetId,
                                    product_name: item.product_name,
                                    category: item.category,
                                    imei_serial: item.imei_serial || null,
                                    color_variant: item.color_variant || null,
                                    quantity: actualTransferQty,
                                    purchase_price: item.purchase_price,
                                    installment_price: item.installment_price,
                                    installment_plans: item.installment_plans || null,
                                    sale_price: item.sale_price || null,
                                    api_product_name: item.api_product_name || null,
                                    status: 'In Stock',
                                    created_at: now(),   // ✅ explicit created_at
                                    updated_at: now()    // ✅ explicit updated_at
                                }
                            });
                        }
                    }
                } else {
                    // Delivery Officer: Row stays at origin but marked 'Out Of Stock' or stays 'Pending'?
                    // Actually for DO, it stays 'Out Of Stock' as it leaves the outlet.
                    if (isFullTransfer) {
                        await tx.outletInventory.update({
                            where: { id: item.id },
                            data: { 
                                status: 'Out Of Stock',
                                updated_at: now()   // ✅ explicit updated_at
                            }
                        });
                    } else {
                        await tx.outletInventory.update({
                            where: { id: item.id },
                            data: { 
                                quantity: item.quantity - actualTransferQty, 
                                status: 'In Stock',
                                updated_at: now()   // ✅ explicit updated_at
                            }
                        });
                        // We might need to create a record of what the DO is carrying, but currently DO inventory isn't explicitly tracked in rows.
                        // It's tracked via StockTransfer and Order status.
                    }
                }

                // Update StockTransfer record status to 'transferred'
                await tx.stockTransfer.updateMany({
                    where: {
                        inventory_id: item.id,
                        from_id: outlet_id,
                        to_id: targetId,
                        status: 'pending'
                    },
                    data: { 
                        status: 'transferred',
                        updated_at: now()   // ✅ explicit updated_at
                    }
                });

                transferData.push({ id: item.id, qty: actualTransferQty });
            }

            // Mark OTP as used with updatedAt
            await tx.otp.update({
                where: { id: otpRecord.id },
                data: { 
                    isUsed: true,
                    updatedAt: now()   // ✅ explicit updatedAt
                }
            });

            return transferData;
        }, { timeout: 15000 });

        // Notifications
        const io = req.app.get('io');
        const messageTitle = 'Stock Transfer Completed';
        const messageBody = `Transfer of ${transfers.length} item batch(es) from Outlet ${outlet_id} to ${to_type} ${targetId} has been verified.`;

        if (io) {
            const receiverRoom = to_type === 'Delivery Officer' ? `user_${targetId}` : `outlet_${targetId}`;
            const senderRoom = `outlet_${outlet_id}`;

            io.to(receiverRoom).emit('stock_transfer_completed', {
                message: 'Stock transferred successfully. Your inventory has been updated.',
                from_id: outlet_id
            });
            io.to(senderRoom).emit('stock_transfer_status', { status: 'completed', to_id: targetId, to_type });
        }

        const itemsDetail = items.map(i => `${i.product_name} (${i.imei_serial || 'No IMEI'})`).join(', ');
        await logAction(req, 'STOCK_TRANSFER_VERIFIED', `Verified transfer of items to ${to_type} ${targetId}: ${itemsDetail}`, null, 'Inventory');

        res.json({ success: true, transfers });
    } catch (error) {
        console.error('verifyStockTransfer error:', error);
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
};


const getTransferHistory = async (req, res) => {
    // ... unchanged (read-only)
    const { outlet_id } = req.user;
    const { page = 1, limit = 20, search = "", to_type, startDate, endDate, direction = 'sent', status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    if (!outlet_id) {
        return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    }

    try {
        const where = {
            from_type: direction === 'sent' ? 'Outlet' : undefined,
            from_id: direction === 'sent' ? outlet_id : undefined,
            to_type: direction === 'received' ? 'Outlet' : (to_type || undefined),
            to_id: direction === 'received' ? outlet_id : undefined,
            status: status || undefined,
            created_at: (startDate || endDate) ? {
                gte: startDate ? new Date(startDate) : undefined,
                lte: endDate ? new Date(endDate) : undefined
            } : undefined,
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

        // Map IDs to human readable names
        const deliveryToIds = [...new Set(transfers.filter(t => t.to_type === 'Delivery Officer').map(t => t.to_id))];
        const outletToIds = [...new Set(transfers.filter(t => t.to_type === 'Outlet').map(t => t.to_id))];
        const outletFromIds = [...new Set(transfers.filter(t => t.from_type === 'Outlet').map(t => t.from_id))];

        const [deliveryOfficers, targetOutlets, sourceOutlets] = await Promise.all([
            prisma.user.findMany({
                where: { id: { in: deliveryToIds } },
                select: { id: true, full_name: true, username: true }
            }),
            prisma.outlet.findMany({
                where: { id: { in: outletToIds } },
                select: { id: true, name: true, address: true }
            }),
            prisma.outlet.findMany({
                where: { id: { in: outletFromIds } },
                select: { id: true, name: true, address: true }
            })
        ]);

        const mappedTransfers = transfers.map(t => {
            let recipientName = 'Unknown';
            let senderName = 'Unknown';

            if (t.to_type === 'Delivery Officer') {
                const off = deliveryOfficers.find(o => o.id === t.to_id);
                if (off) recipientName = `${off.full_name} (${off.username})`;
            } else if (t.to_type === 'Outlet') {
                const out = targetOutlets.find(o => o.id === t.to_id);
                if (out) recipientName = `${out.name} (${out.address || 'No Address'})`;
            }

            if (t.from_type === 'Outlet') {
                const out = sourceOutlets.find(o => o.id === t.from_id);
                if (out) senderName = out.name;
            }

            return {
                ...t,
                recipient_name: recipientName,
                sender_name: senderName
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
        const currentItem = await prisma.outletInventory.findFirst({
            where: { id: parseInt(id), outlet_id },
        });

        if (!currentItem) return res.status(404).json({ success: false, message: 'Item not found' });

        const isReversingUsedStock = currentItem.is_used === true && data.is_used === false;
        const linkedDelivery = currentItem.imei_serial
            ? await prisma.delivery.findFirst({
                where: { product_imei: currentItem.imei_serial },
                select: {
                    order_id: true,
                    order: {
                        select: { id: true, status: true, is_delivered: true },
                    },
                },
            })
            : null;
        const linkedOrder = linkedDelivery?.order
            ? {
                id: linkedDelivery.order.id,
                status: linkedDelivery.order.status,
                is_delivered: linkedDelivery.order.is_delivered,
            }
            : null;

        const resolvedStatus = isReversingUsedStock
            ? (linkedOrder ? 'Sold' : 'In Stock')
            : (data.status !== undefined ? data.status : currentItem.status);

        const updateData = {
            ...(data.product_name !== undefined ? { product_name: data.product_name } : {}),
            ...(data.category !== undefined ? { category: data.category } : {}),
            ...(data.imei_serial !== undefined ? { imei_serial: data.imei_serial } : {}),
            ...(data.color_variant !== undefined ? { color_variant: data.color_variant } : {}),
            ...(data.quantity !== undefined ? { quantity: parseInt(data.quantity) } : {}),
            ...(data.purchase_price !== undefined ? { purchase_price: parseFloat(data.purchase_price) } : {}),
            status: resolvedStatus,
            ...(data.is_used !== undefined ? { is_used: Boolean(data.is_used) } : {}),
            updated_at: now(),
        };

        if (isReversingUsedStock && data.is_used === false) {
            updateData.is_used = false;
        }

        await prisma.outletInventory.update({
            where: { id: currentItem.id },
            data: updateData,
        });

        const shouldRecordReversal = currentItem.is_used === true && data.is_used === false;
        if (shouldRecordReversal) {
            if (linkedOrder) {
                await prisma.order.update({
                    where: { id: linkedOrder.id },
                    data: {
                        status: 'delivered',
                        is_delivered: true,
                        updated_at: now(),
                    },
                });

                await logOrderStatusChange(
                    linkedOrder.id,
                    linkedOrder.status || 'returned',
                    'delivered',
                    req.user,
                    'Restored delivered status after reversing used-stock action',
                    true
                );
            }

            const linkedReturn = linkedOrder
                ? await prisma.returnExchange.findFirst({
                    where: {
                        order_id: linkedOrder.id,
                        imei_returned: currentItem.imei_serial,
                        status: { in: ['pending', 'verified'] },
                    },
                })
                : null;

            if (linkedReturn) {
                await prisma.returnExchange.update({
                    where: { id: linkedReturn.id },
                    data: {
                        status: 'reversed',
                        is_used: false,
                    },
                });
            }

            await prisma.stockTransfer.create({
                data: {
                    from_type: 'Used Stock',
                    from_id: outlet_id,
                    to_type: 'Outlet',
                    to_id: outlet_id,
                    inventory_id: currentItem.id,
                    quantity_transferred: currentItem.quantity || 1,
                    status: 'Used Stock Reversed',
                    created_at: now(),
                    updated_at: now(),
                }
            });

            await logAction(req, 'USED_STOCK_REVERSED', `Reversed used-stock status for inventory item ${currentItem.product_name}${currentItem.imei_serial ? ` (${currentItem.imei_serial})` : ''}.`, currentItem.id, 'OutletInventory');
        }

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
        const item = await prisma.outletInventory.findFirst({ where: { id: parseInt(id), outlet_id } });
        if (!item) return res.status(404).json({ success: false, message: 'Item not found' });

        await prisma.outletInventory.delete({ where: { id: item.id } });
        await logAction(req, 'INVENTORY_DELETED', `Deleted inventory item: ${item.product_name}${item.imei_serial ? ` (IMEI ${item.imei_serial})` : ''}.`, item.id, 'OutletInventory');

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
        
        // Add updated_at for bulk update (same timestamp for all)
        updateData.updated_at = now();

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
        await logAction(req, 'INVENTORY_BULK_DELETED', `Bulk deleted ${deleted.count} inventory item(s).`, null, 'OutletInventory');

        res.json({ success: true, count: deleted.count, message: 'Items deleted successfully' });
    } catch (error) {
        console.error('Bulk delete err:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const cancelStockTransfer = async (req, res) => {
    const { outlet_id } = req.user;
    const { transfer_ids, reason } = req.body;

    if (!outlet_id || !transfer_ids || !Array.isArray(transfer_ids)) {
        return res.status(400).json({ success: false, message: 'Missing transfer IDs.' });
    }

    try {
        const transfers = await prisma.stockTransfer.findMany({
            where: { id: { in: transfer_ids }, from_id: outlet_id, status: 'pending' },
            include: { inventory: true }
        });

        if (transfers.length === 0) {
            return res.status(404).json({ success: false, message: 'No pending transfers found for these IDs.' });
        }

        const inventoryIds = transfers.map(t => t.inventory_id);

        await prisma.$transaction(async (tx) => {
            // 1. Update StockTransfer status with updated_at
            await tx.stockTransfer.updateMany({
                where: { id: { in: transfers.map(t => t.id) } },
                data: { 
                    status: 'cancelled',
                    updated_at: now()   // ✅ explicit updated_at
                }
            });

            // 2. Revert inventory status
            for (const t of transfers) {
                const inv = await tx.outletInventory.findUnique({ where: { id: t.inventory_id } });
                if (inv) {
                    await tx.outletInventory.update({
                        where: { id: inv.id },
                        data: { status: 'In Stock', updated_at: now() }
                    });
                }
            }
        });

        const io = req.app.get('io');
        if (io) {
            transfers.forEach(t => {
                const receiverRoom = t.to_type === 'Delivery Officer' ? `user_${t.to_id}` : `outlet_${t.to_id}`;
                io.to(receiverRoom).emit('stock_transfer_cancelled', { transfer_id: t.id, reason });
            });
        }

        const itemsDetail = transfers.map(t => `${t.inventory?.product_name || 'Item'} (${t.inventory?.imei_serial || 'No IMEI'})`).join(', ');
        await logAction(req, 'STOCK_TRANSFER_CANCELLED', `Cancelled transfer of items: ${itemsDetail}. Reason: ${reason || 'N/A'}`, null, 'Inventory');

        res.json({ success: true, message: 'Transfers cancelled successfully.' });
    } catch (error) {
        console.error('cancelStockTransfer error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const resendStockTransferOTP = async (req, res) => {
    const { outlet_id } = req.user;
    const { to_id, to_type, transfer_ids } = req.body;

    if (!outlet_id || !to_id || !to_type) {
        return res.status(400).json({ success: false, message: 'Missing fields.' });
    }

    try {
        const targetId = parseInt(to_id);
        const recipientIdentifier = to_type === 'Outlet' ? `outlet_${targetId}` : `do_${targetId}`;

        // Find recipient phone
        let recipientPhone = '';
        if (to_type === 'Outlet') {
            const manager = await prisma.user.findFirst({ where: { outlet_id: targetId, role_id: 4 } });
            recipientPhone = manager?.phone || manager?.whatsapp_number || '';
        } else {
            const user = await prisma.user.findUnique({ where: { id: targetId } });
            recipientPhone = user?.phone || user?.whatsapp_number || '';
        }

        const otp = Math.floor(10000 + Math.random() * 90000).toString();

        await prisma.otp.create({
            data: {
                phone: recipientIdentifier,
                otp,
                purpose: 'stock_transfer',
                expiresAt: new Date(Date.now() + 15 * 60000),
                createdAt: now(),   // ✅ explicit createdAt
                updatedAt: now()    // ✅ explicit updatedAt
            }
        });

        // Log OTP
        await prisma.otpLog.create({
            data: {
                user_id: to_type === 'Delivery Officer' ? parseInt(targetId) : req.user.id,
                action: "stock_transfer_otp_resend",
                message: `Stock Transfer OTP Resent: ${otp}. To ${to_type} ${targetId}`,
                otp,
                created_at: now()   // ✅ explicit created_at
            }
        });

        const pendingTransfers = await prisma.stockTransfer.findMany({
            where: {
                from_id: outlet_id,
                to_id: targetId,
                to_type,
                status: 'pending',
                id: (transfer_ids && Array.isArray(transfer_ids)) ? { in: transfer_ids.map(id => parseInt(id)) } : undefined
            },
            include: { inventory: true }
        });

        // Notifications & Sockets
        const io = req.app.get('io');
        if (io) {
            const receiverRoom = to_type === 'Delivery Officer' ? `user_${targetId}` : `outlet_${targetId}`;
            io.to(receiverRoom).emit('stock_transfer_initiated', {
                from_id: outlet_id,
                from_name: req.user.outlet_name || `Outlet ${outlet_id}`,
                otp: otp,
                to_type,
                items_count: pendingTransfers.length,
                items: pendingTransfers.map(t => ({ name: t.inventory.product_name, imei: t.inventory.imei_serial })),
                is_resend: true
            });

            // Specific event for Mobile App (Resend)
            if (to_type === 'Delivery Officer') {
                const appRoom = `user_${targetId}`;
                io.to(appRoom).emit('stock_transfer_otp', {
                    action: "stock_transfer_otp_resend",
                    message: `Your Stock Transfer OTP has been resent: ${otp}`,
                    otp,
                    created_at: now()
                });
            }
        }

        if (recipientPhone) {
            const resendMessage = `Your Stock Transfer OTP has been resent: ${otp}. Please share this with the sender.`;
            await sendOTP(recipientPhone, otp, resendMessage).catch(e => console.error('OTP Service Error:', e));
        }

        // Send FCM Notification for Mobile App (Resend) - pass null for io to avoid duplicate socket event
        const recipientUser = to_type === 'Delivery Officer' ?
            await prisma.user.findUnique({ where: { id: targetId } }) :
            await prisma.user.findFirst({ where: { outlet_id: targetId, role_id: 4 } });

        if (recipientUser) {
            await sendStockTransferOTPNotification(recipientUser, otp, to_type, null).catch(e => console.error('FCM Resend Notification Error:', e));
        }

        res.json({ success: true, message: 'OTP resent successfully.' });
    } catch (error) {
        console.error('resendStockTransferOTP error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const initiateStockBack = async (req, res) => {
    const { transfer_id, transfer_ids } = req.body;
    const requesterId = req.user.id;
    const requesterOutletId = req.user.outlet_id;

    let ids = [];
    if (transfer_ids && Array.isArray(transfer_ids) && transfer_ids.length > 0) {
        ids = transfer_ids;
    } else if (transfer_id) {
        ids = [transfer_id];
    }

    if (ids.length === 0) {
        return res.status(400).json({ success: false, message: 'Missing transfer IDs.' });
    }

    try {
        const transfers = await prisma.stockTransfer.findMany({
            where: { id: { in: ids.map(id => parseInt(id)) } },
            include: { inventory: true }
        });

        if (transfers.length === 0) {
            return res.status(404).json({ success: false, message: 'Transfer records not found.' });
        }

        // Validate all transfers belong to the same original receiver
        const firstTransfer = transfers[0];
        const backGiverId = firstTransfer.to_id;
        const backGiverType = firstTransfer.to_type;

        for (const t of transfers) {
            if (t.to_id !== backGiverId || t.to_type !== backGiverType) {
                return res.status(400).json({ success: false, message: 'All selected transfers must belong to the same recipient.' });
            }
            if (t.status === 'delivered') {
                return res.status(400).json({ success: false, message: 'Cannot back stock for delivered items.' });
            }
            if (t.status !== 'transferred' && t.status !== 'pending') {
                return res.status(400).json({ success: false, message: `Cannot back stock in ${t.status} status.` });
            }
        }

        // Check if requester is authorized (either original sender or original receiver)
        const isAuthorized = (requesterOutletId === firstTransfer.from_id) ||
            (backGiverType === 'Outlet' && requesterOutletId === backGiverId) ||
            (backGiverType === 'Delivery Officer' && requesterId === backGiverId);

        if (!isAuthorized) {
            return res.status(403).json({ success: false, message: 'Unauthorized to initiate stock back for these transfers.' });
        }

        const otp = Math.floor(10000 + Math.random() * 90000).toString();
        const phoneKey = ids.length > 1 ? `back_bulk_${transfers.map(t => t.id).join('_').substring(0, 50)}` : `back_${firstTransfer.id}`;

        const backReceiverId = firstTransfer.from_id;
        const backReceiverType = firstTransfer.from_type; // 'Outlet'

        await prisma.otp.create({
            data: {
                phone: phoneKey,
                otp,
                purpose: 'stock_back',
                expiresAt: new Date(Date.now() + 10 * 60000),
                createdAt: now(),
                updatedAt: now()
            }
        });

        // Notifications & Sockets
        const io = req.app.get('io');
        if (io) {
            const giverRoom = backGiverType === 'Delivery Officer' ? `user_${backGiverId}` : `outlet_${backGiverId}`;
            const receiverRoom = backReceiverType === 'Delivery Officer' ? `user_${backReceiverId}` : `outlet_${backReceiverId}`;

            // Notify Receiver (Original Sender) - They get the OTP
            io.to(receiverRoom).emit('stock_back_initiated', {
                transfer_id: ids[0],
                transfer_ids: ids,
                otp: otp,
                product_name: ids.length > 1 ? 'Bulk Items' : firstTransfer.inventory?.product_name,
                imei_serial: ids.length > 1 ? null : firstTransfer.inventory?.imei_serial,
                role: 'receiver'
            });

            // Notify Giver (Original Receiver) - They get the OTP input popup
            io.to(giverRoom).emit('stock_back_initiated', {
                transfer_id: ids[0],
                transfer_ids: ids,
                product_name: ids.length > 1 ? 'Bulk Items' : firstTransfer.inventory?.product_name,
                imei_serial: ids.length > 1 ? null : firstTransfer.inventory?.imei_serial,
                role: 'giver'
            });
        }

        res.json({ success: true, message: 'Stock back initiated. OTP sent to the other party.', phoneKey });
    } catch (error) {
        console.error('initiateStockBack error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const verifyStockBack = async (req, res) => {
    const { transfer_id, transfer_ids, otp, phoneKey } = req.body;

    let ids = [];
    if (transfer_ids && Array.isArray(transfer_ids) && transfer_ids.length > 0) {
        ids = transfer_ids;
    } else if (transfer_id) {
        ids = [transfer_id];
    }

    if (ids.length === 0 || !otp) {
        return res.status(400).json({ success: false, message: 'Missing fields.' });
    }

    try {
        const transfers = await prisma.stockTransfer.findMany({
            where: { id: { in: ids.map(id => parseInt(id)) } },
            include: { inventory: true }
        });

        if (transfers.length === 0) return res.status(404).json({ success: false, message: 'Transfers not found.' });

        // Build the key that was used when the OTP was stored
        // For bulk, we may only have one transfer_id from mobile but the key includes all IDs.
        // Strategy: find by otp+purpose first, then validate it covers these transfer IDs.
        let otpRecord = null;

        if (phoneKey) {
            // Explicit key provided (from web dashboard)
            otpRecord = await prisma.otp.findFirst({
                where: { phone: phoneKey, otp, purpose: 'stock_back', isUsed: false },
                orderBy: { createdAt: 'desc' }
            });
        }

        if (!otpRecord) {
            // Try single-item key first
            const singleKey = `back_${transfers[0].id}`;
            otpRecord = await prisma.otp.findFirst({
                where: { phone: singleKey, otp, purpose: 'stock_back', isUsed: false },
                orderBy: { createdAt: 'desc' }
            });
        }

        if (!otpRecord) {
            // Try finding by OTP value alone (for bulk where mobile only sends one transfer_id)
            // Pick the most recent unexpired stock_back OTP with this value
            otpRecord = await prisma.otp.findFirst({
                where: { 
                    otp, 
                    purpose: 'stock_back', 
                    isUsed: false,
                    expiresAt: { gt: new Date() }
                },
                orderBy: { createdAt: 'desc' }
            });

            // If found, verify that this OTP's phone key actually covers the given transfer_id(s)
            if (otpRecord) {
                const key = otpRecord.phone;
                // bulk keys look like: back_bulk_1_2_3 or back_bulk_1_2_3_4...
                // single keys look like: back_<id>
                const isBulkKey = key.startsWith('back_bulk_');
                const isSingleKey = key.startsWith('back_') && !isBulkKey;
                
                if (isSingleKey) {
                    const keyId = parseInt(key.replace('back_', ''));
                    if (!ids.map(id => parseInt(id)).includes(keyId)) {
                        otpRecord = null; // Does not match
                    }
                }
                // For bulk keys, we accept it since mobile only has partial info
                // The OTP value being correct is sufficient for bulk verification
            }
        }

        if (!otpRecord || otpRecord.expiresAt < new Date()) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
        }

        // For bulk OTPs, we need to get ALL transfer IDs covered by this OTP (not just what mobile sent)
        const bulkKey = otpRecord.phone;
        if (bulkKey.startsWith('back_bulk_')) {
            // Extract IDs from key: back_bulk_1_2_3 → [1, 2, 3]
            const keyPart = bulkKey.replace('back_bulk_', '');
            const keyIds = keyPart.split('_').map(id => parseInt(id)).filter(id => !isNaN(id));
            if (keyIds.length > ids.length) {
                // Fetch all transfers for this OTP, not just the one the mobile sent
                const allTransfers = await prisma.stockTransfer.findMany({
                    where: { id: { in: keyIds } },
                    include: { inventory: true }
                });
                if (allTransfers.length > 0) {
                    // Replace transfers list with full set
                    transfers.length = 0;
                    transfers.push(...allTransfers);
                }
            }
        }

        await prisma.$transaction(async (tx) => {
            for (const transfer of transfers) {
                // 1. Update Inventory
                if (transfer.status === 'transferred' || transfer.status === 'delivered') {
                    if (transfer.to_type === 'Outlet') {
                        // Move from target outlet back to origin outlet
                        await tx.outletInventory.update({
                            where: { id: transfer.inventory_id },
                            data: { 
                                outlet_id: transfer.from_id, 
                                status: 'In Stock',
                                updated_at: now()
                            }
                        });
                    } else if (transfer.to_type === 'Delivery Officer') {
                        // Mark as In Stock at origin outlet
                        await tx.outletInventory.update({
                            where: { id: transfer.inventory_id },
                            data: { 
                                status: 'In Stock',
                                updated_at: now()
                            }
                        });
                    }
                } else if (transfer.status === 'pending') {
                    // It was pending, just revert to In Stock
                    await tx.outletInventory.update({
                        where: { id: transfer.inventory_id },
                        data: { 
                            status: 'In Stock',
                            updated_at: now()
                        }
                    });
                }

                // 2. Update StockTransfer status to 'Stock Back'
                await tx.stockTransfer.update({
                    where: { id: transfer.id },
                    data: { 
                        status: 'Stock Back',
                        updated_at: now()
                    }
                });
            }

            // 3. Mark OTP as used
            await tx.otp.update({
                where: { id: otpRecord.id },
                data: { 
                    isUsed: true,
                    updatedAt: now()
                }
            });
        });

        const io = req.app.get('io');
        if (io) {
            const firstTransfer = transfers[0];
            const giverRoom = firstTransfer.to_type === 'Delivery Officer' ? `user_${firstTransfer.to_id}` : `outlet_${firstTransfer.to_id}`;
            const receiverRoom = firstTransfer.from_type === 'Delivery Officer' ? `user_${firstTransfer.from_id}` : `outlet_${firstTransfer.from_id}`;

            io.to(giverRoom).emit('stock_back_completed', { transfer_ids: ids, success: true });
            io.to(receiverRoom).emit('stock_back_completed', { transfer_ids: ids, success: true });
        }

        const firstTransfer = transfers[0];
        const giverName = firstTransfer.to_type === 'Delivery Officer'
            ? (await prisma.user.findUnique({ where: { id: firstTransfer.to_id }, select: { full_name: true } }))?.full_name || `User ${firstTransfer.to_id}`
            : (await prisma.outlet.findUnique({ where: { id: firstTransfer.to_id }, select: { name: true } }))?.name || `Outlet ${firstTransfer.to_id}`;

        const itemsDetail = transfers.map(t => `${t.inventory?.product_name} (${t.inventory?.imei_serial || 'No IMEI'})`).join(', ');
        const logMsg = `Stock Back Verified: ${transfers.length} item(s) returned from ${firstTransfer.to_type} ${giverName} to Outlet ${firstTransfer.from_id}. Items: ${itemsDetail}`;

        await logAction(req, 'STOCK_BACK_VERIFIED', logMsg, null, 'Inventory');

        res.json({ success: true, message: 'Stock returned successfully.' });
    } catch (error) {
        console.error('verifyStockBack error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// ─── Sync Product Plans from qistmarket API ───────────────────────────────────
// Called when a product's price or installment plan changes on qistmarket.pk
// POST /api/inventory/sync-product-plans
// Body: { product_name, new_price, new_installments: [{advance, totalPrice, monthlyAmount, months, isActive}] }
const syncProductPlans = async (req, res) => {
    const { product_name, new_price, new_installments } = req.body;

    if (!product_name) {
        return res.status(400).json({ success: false, message: 'product_name is required.' });
    }

    if (!new_installments || !Array.isArray(new_installments) || new_installments.length === 0) {
        return res.status(400).json({ success: false, message: 'new_installments array is required.' });
    }

    try {
        const normalizedName = product_name.trim().toLowerCase();

        // Find all inventory records linked to this API product (case-insensitive)
        const matchingRecords = await prisma.outletInventory.findMany({
            where: {
                api_product_name: {
                    equals: normalizedName,
                    mode: 'insensitive'
                }
            },
            select: { id: true }
        });

        if (matchingRecords.length === 0) {
            return res.json({ 
                success: true, 
                updated: 0, 
                message: 'No inventory records found for this product.' 
            });
        }

        const ids = matchingRecords.map(r => r.id);

        const formattedPlans = new_installments.map(i => ({
            advance: parseFloat(i.advance) || 0,
            totalPrice: parseFloat(i.totalPrice) || 0,
            monthlyAmount: parseFloat(i.monthlyAmount) || 0,
            months: parseInt(i.months) || 0,
            isActive: i.isActive !== false,
        }));

        const updateData = {
            installment_plans: formattedPlans,
            updated_at: now()   // ✅ explicit updated_at
        };
        if (new_price !== undefined && new_price !== null) {
            updateData.sale_price = parseFloat(new_price) || null;
        }

        await prisma.outletInventory.updateMany({
            where: { id: { in: ids } },
            data: updateData
        });

        console.log(`syncProductPlans: Updated ${ids.length} inventory records for "${product_name}"`);

        res.json({ 
            success: true, 
            updated: ids.length, 
            message: `Updated plans and sale price for ${ids.length} inventory record(s).` 
        });
    } catch (error) {
        console.error('syncProductPlans error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * searchByImeiGlobal
 * Outlet-accessible global IMEI/Serial trace:
 *   - Current inventory record (which outlet it is at right now)
 *   - Full stock transfer history (where it moved)
 *   - Return/exchange records
 *   - Order delivery record (if it was sold)
 */
const searchByImeiGlobal = async (req, res) => {
    try {
        const { imei } = req.params;
        if (!imei || imei.trim().length < 4) {
            return res.status(400).json({ success: false, message: 'کم از کم 4 digits درج کریں۔' });
        }
        const cleanImei = imei.trim();

        const [inventoryItems, rawTransferHistory, returnHistory, deliveryRecord] = await Promise.all([
            // Current inventory record across ALL outlets
            prisma.outletInventory.findMany({
                where: { imei_serial: { contains: cleanImei } },
                include: { outlet: { select: { id: true, name: true, code: true, address: true } } },
                take: 10,
            }),
            // Stock transfer history for this IMEI
            prisma.stockTransfer.findMany({
                where: { inventory: { imei_serial: { contains: cleanImei } } },
                include: {
                    inventory: { select: { imei_serial: true, product_name: true } }
                },
                orderBy: { created_at: 'desc' },
                take: 20,
            }),
            // Return/exchange records
            prisma.returnExchange.findMany({
                where: { imei_returned: { contains: cleanImei } },
                include: { outlet: { select: { name: true, code: true } } },
                orderBy: { created_at: 'desc' },
                take: 10,
            }),
            // Delivery order (if sold)
            prisma.delivery.findFirst({
                where: { product_imei: { contains: cleanImei } },
                include: {
                    order: {
                        select: {
                            order_ref: true,
                            status: true,
                            created_at: true,
                            customer_name: true,
                            whatsapp_number: true,
                            outlet: { select: { name: true, code: true } },
                        },
                    },
                },
            }),
        ]);

        const outletIds = new Set();
        const userIds = new Set();
        rawTransferHistory.forEach(t => {
            if (t.from_type === 'Outlet') outletIds.add(t.from_id);
            else if (t.from_type) userIds.add(t.from_id);

            if (t.to_type === 'Outlet') outletIds.add(t.to_id);
            else if (t.to_type) userIds.add(t.to_id);
        });

        const [outlets, users] = await Promise.all([
            prisma.outlet.findMany({
                where: { id: { in: [...outletIds] } },
                select: { id: true, name: true, code: true }
            }),
            prisma.user.findMany({
                where: { id: { in: [...userIds] } },
                select: { id: true, full_name: true, username: true }
            })
        ]);

        const outletMap = {};
        outlets.forEach(o => outletMap[o.id] = o);
        
        const userMap = {};
        users.forEach(u => userMap[u.id] = u);

        res.json({
            success: true,
            data: {
                inventory: inventoryItems.map(i => ({
                    id: i.id,
                    imei_serial: i.imei_serial,
                    product_name: i.product_name,
                    category: i.category,
                    color_variant: i.color_variant,
                    status: i.status,
                    purchase_price: i.purchase_price,
                    created_at: i.created_at,
                    outlet: i.outlet,
                })),
                transferHistory: rawTransferHistory.map(t => {
                    let fromName = t.from_type;
                    let toName = t.to_type;

                    if (t.from_type === 'Outlet') {
                        fromName = outletMap[t.from_id] ? outletMap[t.from_id].name : 'Unknown Outlet';
                    } else if (t.from_type) {
                        fromName = userMap[t.from_id] ? `${t.from_type} (${userMap[t.from_id].username})` : t.from_type;
                    }

                    if (t.to_type === 'Outlet') {
                        toName = outletMap[t.to_id] ? outletMap[t.to_id].name : 'Unknown Outlet';
                    } else if (t.to_type) {
                        toName = userMap[t.to_id] ? `${t.to_type} (${userMap[t.to_id].username})` : t.to_type;
                    }

                    return {
                        id: t.id,
                        imei_serial: t.inventory?.imei_serial,
                        product_name: t.inventory?.product_name,
                        status: t.status,
                        from_outlet: { name: fromName, code: t.from_type === 'Outlet' && outletMap[t.from_id] ? outletMap[t.from_id].code : '' },
                        to_outlet: { name: toName, code: t.to_type === 'Outlet' && outletMap[t.to_id] ? outletMap[t.to_id].code : '' },
                        created_at: t.created_at,
                        completed_at: t.updated_at,
                    };
                }),
                returnHistory: returnHistory.map(r => ({
                    id: r.id,
                    imei_returned: r.imei_returned,
                    status: r.status,
                    outlet: r.outlet,
                    created_at: r.created_at,
                })),
                deliveryRecord: deliveryRecord ? {
                    product_imei: deliveryRecord.product_imei,
                    order_ref: deliveryRecord.order?.order_ref,
                    order_status: deliveryRecord.order?.status,
                    customer_name: deliveryRecord.order?.customer_name,
                    customer_phone: deliveryRecord.order?.whatsapp_number,
                    outlet: deliveryRecord.order?.outlet,
                    order_date: deliveryRecord.order?.created_at,
                } : null,
            },
        });
    } catch (error) {
        console.error('searchByImeiGlobal error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getInventory,
    getStockTransferInventory,
    getUsedInventory,
    getUsedInventoryReversalHistory,
    addInventory,
    initiateStockTransfer,
    verifyStockTransfer,
    getTransferHistory,
    cancelStockTransfer,
    resendStockTransferOTP,
    initiateStockBack,
    verifyStockBack,
    updateInventoryItem,
    deleteInventoryItem,
    bulkUpdateInventory,
    bulkDeleteInventory,
    generateInstallments,
    syncProductPlans,
    searchByImeiGlobal,
};