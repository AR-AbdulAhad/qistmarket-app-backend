const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const getVendorPurchases = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    try {
        const purchases = await prisma.vendorPurchase.findMany({ where: { outlet_id } });
        res.json({ success: true, purchases });
    } catch (error) {
        console.error('getVendorPurchases error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const addVendorPurchase = async (req, res) => {
    const { outlet_id } = req.user;
    const { vendor_name, product_name, imei_serial, quantity, purchase_price } = req.body;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    if (!vendor_name || !product_name || !imei_serial || !purchase_price) {
        return res.status(400).json({ success: false, message: 'Missing fields' });
    }

    try {
        const existing = await prisma.outletInventory.findUnique({ where: { imei_serial } });
        if (existing) {
            return res.status(400).json({ success: false, message: 'Duplicate IMEI.' });
        }

        const purchase = await prisma.$transaction([
            prisma.vendorPurchase.create({
                data: {
                    outlet_id,
                    vendor_name,
                    product_name,
                    imei_serial,
                    quantity: quantity || 1,
                    purchase_price
                }
            }),
            prisma.outletInventory.create({
                data: {
                    outlet_id,
                    product_name,
                    imei_serial,
                    purchase_price,
                    installment_price: 0 // Default, can be updated later
                }
            })
        ]);

        res.status(201).json({ success: true, purchase });
    } catch (error) {
        console.error('addVendorPurchase error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getVendorPayments = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    try {
        const payments = await prisma.vendorPayment.findMany({ where: { outlet_id } });
        res.json({ success: true, payments });
    } catch (error) {
        console.error('getVendorPayments error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const addVendorPayment = async (req, res) => {
    const { outlet_id } = req.user;
    const { vendor_name, amount, payment_method } = req.body;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    try {
        const payment = await prisma.vendorPayment.create({
            data: {
                outlet_id,
                vendor_name,
                amount,
                payment_method
            }
        });
        res.status(201).json({ success: true, payment });
    } catch (error) {
        console.error('addVendorPayment error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getVendorPurchases,
    addVendorPurchase,
    getVendorPayments,
    addVendorPayment
};
