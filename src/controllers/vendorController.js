const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { updateCashRegister } = require('../utils/cashRegisterUtils');

// Helper to generate Invoice Number: QM-YYYY-XXXX
const generateInvoiceNumber = async (tx) => {
    const year = new Date().getFullYear();
    const prefix = `PUR-${year}-`;
    
    // Find the latest invoice for this year
    const lastPurchase = await tx.vendorPurchase.findFirst({
        where: { invoice_number: { startsWith: prefix } },
        orderBy: { invoice_number: 'desc' },
        select: { invoice_number: true }
    });

    let nextNumber = 1;
    if (lastPurchase) {
        const lastSerial = parseInt(lastPurchase.invoice_number.split('-')[2]);
        nextNumber = lastSerial + 1;
    }

    return `${prefix}${nextNumber.toString().padStart(4, '0')}`;
};

const createPurchase = async (req, res) => {
    const { outlet_id } = req.user;
    const { vendor_name, purchase_date, notes, items } = req.body;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    if (!vendor_name || !items || !items.length) {
        return res.status(400).json({ success: false, message: 'Vendor name and items are required.' });
    }

    try {
        const result = await prisma.$transaction(async (tx) => {
            const invoice_number = await generateInvoiceNumber(tx);
            
            let totalAmount = 0;
            const purchaseItemsData = [];
            const inventoryData = [];

            for (const item of items) {
                const qty = parseInt(item.quantity) || 1;
                const unitPrice = parseFloat(item.unit_price) || 0;
                const totalPrice = qty * unitPrice;
                totalAmount += totalPrice;

                purchaseItemsData.push({
                    product_name: item.product_name,
                    category: item.category,
                    color_variant: item.color_variant,
                    imei_serial: item.imei_serial,
                    quantity: qty,
                    unit_price: unitPrice,
                    total_price: totalPrice
                });

                // Add to inventory
                inventoryData.push({
                    outlet_id,
                    product_name: item.product_name,
                    category: item.category,
                    color_variant: item.color_variant,
                    imei_serial: item.imei_serial,
                    quantity: qty,
                    purchase_price: unitPrice,
                    installment_price: 0, 
                    status: 'In Stock'
                });
            }

            const purchase = await tx.vendorPurchase.create({
                data: {
                    outlet_id,
                    invoice_number,
                    vendor_name,
                    notes,
                    total_amount: totalAmount,
                    balance: totalAmount,
                    status: 'Unpaid',
                    purchase_date: purchase_date ? new Date(purchase_date) : new Date(),
                    items: {
                        create: purchaseItemsData
                    }
                },
                include: { items: true }
            });

            // Create inventory records
            await tx.outletInventory.createMany({
                data: inventoryData
            });

            return purchase;
        });

        res.status(201).json({ success: true, purchase: result });
    } catch (error) {
        console.error('createPurchase error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getPurchases = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    try {
        const purchases = await prisma.vendorPurchase.findMany({
            where: { outlet_id },
            include: { items: true },
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
            include: { items: true, payments: true }
        });

        if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found.' });
        res.json({ success: true, purchase });
    } catch (error) {
        console.error('getPurchaseById error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
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

            const newPaidAmount = purchase.paid_amount + parseFloat(amount);
            const newBalance = purchase.total_amount - newPaidAmount;
            let status = 'Partial';
            if (newBalance <= 0) status = 'Paid';
            if (newPaidAmount === 0) status = 'Unpaid';

            const payment = await tx.vendorPayment.create({
                data: {
                    outlet_id,
                    purchase_id: purchase.id,
                    vendor_name: purchase.vendor_name,
                    amount: parseFloat(amount),
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

            // Update Cash Register
            await updateCashRegister(tx, outlet_id, 'vendor_payments', parseFloat(amount), 'add');

            return payment;
        });

        res.json({ success: true, payment: result });
    } catch (error) {
        console.error('recordPayment error:', error);
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
};

const getVendorSummary = async (req, res) => {
    const { outlet_id } = req.user;

    try {
        const summary = await prisma.vendorPurchase.groupBy({
            by: ['vendor_name'],
            where: { outlet_id },
            _sum: {
                total_amount: true,
                paid_amount: true,
                balance: true
            }
        });

        res.json({ success: true, summary });
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
        await prisma.vendorPurchase.deleteMany({
            where: { id: parseInt(id), outlet_id }
        });
        res.json({ success: true, message: 'Purchase deleted successfully.' });
    } catch (error) {
        console.error('deletePurchase error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    createPurchase,
    getPurchases,
    getPurchaseById,
    recordPayment,
    getVendorSummary,
    getPayments,
    deletePurchase
};
