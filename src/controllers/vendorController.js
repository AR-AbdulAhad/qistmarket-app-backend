const prisma = require('../../lib/prisma');
const { updateCashRegister } = require('../utils/cashRegisterUtils');
const { logAction } = require('../utils/auditLogger');
const { generateInstallments } = require('./inventoryController');

// Helper to generate Invoice Number: PUR-YYYY-XXXX
const generateInvoiceNumber = async (tx) => {
    const year = new Date().getFullYear();
    const prefix = `PUR-${year}-`;
    
    const lastPurchase = await tx.vendorPurchase.findFirst({
        where: { invoice_number: { startsWith: prefix } },
        orderBy: { invoice_number: 'desc' },
        select: { invoice_number: true }
    });

    let nextNumber = 1;
    if (lastPurchase) {
        const parts = lastPurchase.invoice_number.split('-');
        if (parts.length >= 3) {
            nextNumber = parseInt(parts[2]) + 1;
        }
    }

    return `${prefix}${nextNumber.toString().padStart(4, '0')}`;
};

// --- Vendor CRUD ---

const getVendors = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Unauthorized' });

    try {
        const vendors = await prisma.vendor.findMany({
            where: { outlet_id },
            orderBy: { name: 'asc' }
        });
        res.json({ success: true, vendors });
    } catch (error) {
        console.error('getVendors error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const createVendor = async (req, res) => {
    const { outlet_id } = req.user;
    const { name, phone, email, address } = req.body;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (!name) return res.status(400).json({ success: false, message: 'Name is required' });

    try {
        const vendor = await prisma.vendor.create({
            data: { outlet_id, name, phone, email, address }
        });
        res.status(201).json({ success: true, vendor });
    } catch (error) {
        console.error('createVendor error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

const updateVendor = async (req, res) => {
    const { id } = req.params;
    const { name, phone, email, address } = req.body;

    try {
        const vendor = await prisma.vendor.update({
            where: { id: parseInt(id) },
            data: { name, phone, email, address }
        });
        res.json({ success: true, vendor });
    } catch (error) {
        console.error('updateVendor error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// --- Purchases ---

const createPurchase = async (req, res) => {
    const { outlet_id } = req.user;
    const { vendor_id, vendor_name, purchase_date, due_date, notes, items } = req.body;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    if (!items || !items.length) {
        return res.status(400).json({ success: false, message: 'Items are required.' });
    }

    try {
        const result = await prisma.$transaction(async (tx) => {
            const invoice_number = await generateInvoiceNumber(tx);
            
            // 1. Resolve Vendor
            let finalVendorId = vendor_id ? parseInt(vendor_id) : null;
            let finalVendorName = vendor_name;

            if (!finalVendorId && vendor_name) {
                // Try to find vendor by name for this outlet first
                let existingVendor = await tx.vendor.findFirst({
                    where: { outlet_id, name: vendor_name }
                });
                if (!existingVendor) {
                    existingVendor = await tx.vendor.create({
                        data: { outlet_id, name: vendor_name }
                    });
                }
                finalVendorId = existingVendor.id;
                finalVendorName = existingVendor.name;
            }

            let totalAmount = 0;
            const purchaseItemsData = [];
            const inventoryData = [];

            for (const item of items) {
                const qty = parseInt(item.quantity) || 1;
                const unitPrice = parseFloat(item.unit_price) || 0;
                const totalPrice = qty * unitPrice;
                totalAmount += totalPrice;

                // Check for unique IMEI/Serial if provided (System-wide check)
                if (item.imei_serial && item.imei_serial.trim() !== '') {
                    const duplicate = await tx.outletInventory.findFirst({
                        where: {
                            imei_serial: item.imei_serial.trim()
                        }
                    });
                    if (duplicate) {
                        throw new Error(`IMEI/Serial ${item.imei_serial} already exists.`);
                    }
                }

                purchaseItemsData.push({
                    product_name: item.product_name,
                    category: item.category,
                    color_variant: item.color_variant,
                    imei_serial: item.imei_serial ? item.imei_serial.trim() : null,
                    quantity: qty,
                    unit_price: unitPrice,
                    total_price: totalPrice
                });

                // Add or update inventory
                const existingItem = await tx.outletInventory.findFirst({
                    where: {
                        outlet_id,
                        product_name: item.product_name,
                        imei_serial: item.imei_serial ? item.imei_serial.trim() : null,
                        color_variant: item.color_variant || null
                    }
                });

                if (existingItem) {
                    await tx.outletInventory.update({
                        where: { id: existingItem.id },
                        data: {
                            quantity: existingItem.quantity + qty,
                            purchase_price: unitPrice,
                            status: 'In Stock',
                            category: item.category || existingItem.category,
                            color_variant: item.color_variant || existingItem.color_variant,
                            installment_plans: generateInstallments(item.category || existingItem.category || '', unitPrice)
                        }
                    });
                } else {
                    await tx.outletInventory.create({
                        data: {
                            outlet_id,
                            product_name: item.product_name,
                            category: item.category,
                            color_variant: item.color_variant,
                            imei_serial: item.imei_serial ? item.imei_serial.trim() : null,
                            quantity: qty,
                            purchase_price: unitPrice,
                            installment_price: 0,
                            installment_plans: generateInstallments(item.category || '', unitPrice),
                            status: 'In Stock'
                        }
                    });
                }
            }

            const purchase = await tx.vendorPurchase.create({
                data: {
                    outlet_id,
                    vendor_id: finalVendorId,
                    invoice_number,
                    vendor_name: finalVendorName,
                    notes,
                    total_amount: totalAmount,
                    balance: totalAmount,
                    status: 'Unpaid',
                    due_date: due_date ? new Date(due_date) : null,
                    purchase_date: purchase_date ? new Date(purchase_date) : new Date(),
                    items: {
                        create: purchaseItemsData
                    }
                },
                include: { items: true }
            });

            // Update Vendor Balance
            if (finalVendorId) {
                await tx.vendor.update({
                    where: { id: finalVendorId },
                    data: { balance: { increment: totalAmount } }
                });
            }

            return purchase;
        }, {
            maxWait: 5000,
            timeout: 15000
        });

        await logAction(
            req, 
            'VENDOR_PURCHASE', 
            `Recorded purchase ${result.invoice_number} from ${result.vendor_name} for PKR ${result.total_amount}.`,
            result.id,
            'VendorPurchase'
        );

        res.status(201).json({ success: true, purchase: result });
    } catch (error) {
        const isValidationError = error.message.includes('exists in stock') || error.message.includes('required');
        if (!isValidationError) {
            console.error('createPurchase error:', error);
        }
        res.status(isValidationError ? 400 : 500).json({ 
            success: false, 
            message: error.message || 'Internal server error' 
        });
    }
};

const recordPayment = async (req, res) => {
    const { outlet_id } = req.user;
    const { purchase_id, amount, payment_method, notes } = req.body;

    if (!purchase_id || !amount) {
        return res.status(400).json({ success: false, message: 'Purchase ID and amount are required.' });
    }

    try {
        const result = await prisma.$transaction(async (tx) => {
            const purchase = await tx.vendorPurchase.findUnique({
                where: { id: parseInt(purchase_id) }
            });

            if (!purchase || purchase.outlet_id !== outlet_id) {
                throw new Error('Purchase not found.');
            }

            const amtNum = parseFloat(amount);
            const newPaidAmount = purchase.paid_amount + amtNum;
            const newBalance = purchase.total_amount - newPaidAmount;
            let status = 'Partial';
            if (newBalance <= 0) status = 'Paid';
            if (newPaidAmount === 0) status = 'Unpaid';

            const payment = await tx.vendorPayment.create({
                data: {
                    outlet_id,
                    purchase_id: purchase.id,
                    vendor_id: purchase.vendor_id,
                    vendor_name: purchase.vendor_name,
                    amount: amtNum,
                    payment_method,
                    notes
                }
            });

            await tx.vendorPurchase.update({
                where: { id: purchase.id },
                data: {
                    paid_amount: newPaidAmount,
                    balance: newBalance,
                    status
                }
            });

            // Update Vendor Global Balance
            if (purchase.vendor_id) {
                await tx.vendor.update({
                    where: { id: purchase.vendor_id },
                    data: { balance: { decrement: amtNum } }
                });
            }

            // Update Cash Register (Vendor Payment is an outflow)
            await updateCashRegister(tx, outlet_id, 'vendor_payments', amtNum, 'add');

            return payment;
        }, {
            maxWait: 5000,
            timeout: 15000
        });

        await logAction(
            req, 
            'VENDOR_PAYMENT', 
            `Paid PKR ${result.amount} to ${result.vendor_name} for invoice ${result.purchase_id}.`,
            result.id,
            'VendorPayment'
        );

        res.json({ success: true, payment: result });
    } catch (error) {
        console.error('recordPayment error:', error);
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
};

const getVendorLedger = async (req, res) => {
    const { id } = req.params;
    const { outlet_id } = req.user;

    try {
        const vendor = await prisma.vendor.findFirst({
            where: { id: parseInt(id), outlet_id }
        });

        if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });

        const purchases = await prisma.vendorPurchase.findMany({
            where: { vendor_id: vendor.id },
            include: { items: true },
            orderBy: { purchase_date: 'asc' }
        });

        const payments = await prisma.vendorPayment.findMany({
            where: { vendor_id: vendor.id },
            orderBy: { created_at: 'asc' }
        });

        // Merge and Sort
        const ledger = [
            ...purchases.map(p => ({
                id: p.id,
                type: 'Purchase',
                reference: p.invoice_number,
                date: p.purchase_date,
                due_date: p.due_date,
                amount: p.total_amount,
                debit: p.total_amount, // Balance Increase
                credit: 0,
                notes: p.notes
            })),
            ...payments.map(py => ({
                id: py.id,
                type: 'Payment',
                reference: `PAY-${py.id}`,
                date: py.created_at,
                amount: py.amount,
                debit: 0,
                credit: py.amount, // Balance Decrease
                notes: py.notes
            }))
        ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

        // Calculate running balance
        let runBal = 0;
        const ledgerWithBalance = ledger.map(entry => {
            runBal += (entry.debit - entry.credit);
            return { ...entry, running_balance: runBal };
        });

        res.json({ 
            success: true, 
            vendor, 
            ledger: ledgerWithBalance.reverse() // Newest first for UI 
        });
    } catch (error) {
        console.error('getVendorLedger error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// --- Other getters ---

const getPurchases = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    try {
        const purchases = await prisma.vendorPurchase.findMany({
            where: { outlet_id },
            include: { items: true, vendor: true },
            orderBy: { created_at: 'desc' }
        });
        res.json({ success: true, purchases });
    } catch (error) {
        console.error('getPurchases error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getPurchaseById = async (req, res) => {
    const { id } = req.params;
    const { outlet_id } = req.user;

    try {
        const purchase = await prisma.vendorPurchase.findFirst({
            where: { id: parseInt(id), outlet_id },
            include: { items: true, payments: true, vendor: true }
        });

        if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found.' });
        res.json({ success: true, purchase });
    } catch (error) {
        console.error('getPurchaseById error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getVendorSummary = async (req, res) => {
    const { outlet_id } = req.user;

    try {
        // We aggregate from VendorPurchase to get total_amount and paid_amount
        // and link to Vendor to get the formal name/id
        const summary = await prisma.vendorPurchase.groupBy({
            by: ['vendor_name', 'vendor_id'],
            where: { outlet_id },
            _sum: {
                total_amount: true,
                paid_amount: true,
                balance: true
            }
        });

        // Map it to include _sum structure for frontend compatibility
        const formattedSummary = summary.map(s => ({
            vendor_name: s.vendor_name,
            vendor_id: s.vendor_id,
            _sum: {
                total_amount: s._sum.total_amount || 0,
                paid_amount: s._sum.paid_amount || 0,
                balance: s._sum.balance || 0
            }
        }));

        res.json({ success: true, summary: formattedSummary });
    } catch (error) {
        console.error('getVendorSummary error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getPayments = async (req, res) => {
    const { outlet_id } = req.user;
    try {
        const payments = await prisma.vendorPayment.findMany({
            where: { outlet_id },
            include: { vendor: true },
            orderBy: { created_at: 'desc' }
        });
        res.json({ success: true, payments });
    } catch (error) {
        console.error('getPayments error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const deletePurchase = async (req, res) => {
    const { id } = req.params;
    const { outlet_id } = req.user;

    try {
        await prisma.$transaction(async (tx) => {
            const purchase = await tx.vendorPurchase.findUnique({
                where: { id: parseInt(id) },
                include: { items: true }
            });
            if (!purchase || purchase.outlet_id !== outlet_id) throw new Error('Not found');

            // 1. Revert Inventory
            for (const item of purchase.items) {
                const inventoryItem = await tx.outletInventory.findFirst({
                    where: {
                        outlet_id,
                        product_name: item.product_name,
                        imei_serial: item.imei_serial || null,
                        color_variant: item.color_variant || null
                    }
                });

                if (inventoryItem) {
                    const newQty = inventoryItem.quantity - item.quantity;
                    if (newQty <= 0) {
                        // Delete if quantity becomes 0 or less
                        await tx.outletInventory.delete({ where: { id: inventoryItem.id } });
                    } else {
                        // Reduce quantity
                        await tx.outletInventory.update({
                            where: { id: inventoryItem.id },
                            data: { quantity: newQty }
                        });
                    }
                }
            }

            // 2. Revert Vendor balance if linked
            if (purchase.vendor_id) {
                await tx.vendor.update({
                    where: { id: purchase.vendor_id },
                    data: { balance: { decrement: purchase.total_amount - purchase.paid_amount } }
                });
            }

            await tx.vendorPurchase.delete({ where: { id: purchase.id } });
        }, {
            maxWait: 5000,
            timeout: 15000
        });
        res.json({ success: true, message: 'Purchase deleted successfully.' });
    } catch (error) {
        console.error('deletePurchase error:', error);
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
};

module.exports = {
    getVendors,
    createVendor,
    updateVendor,
    createPurchase,
    getPurchases,
    getPurchaseById,
    recordPayment,
    getVendorSummary,
    getPayments,
    deletePurchase,
    getVendorLedger
};
