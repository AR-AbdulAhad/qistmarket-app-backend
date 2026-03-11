const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const getInventory = async (req, res) => {
    const { outlet_id } = req.user;

    if (!outlet_id) {
        return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    }

    try {
        const inventory = await prisma.outletInventory.findMany({
            where: { outlet_id }
        });
        res.json({ success: true, inventory });
    } catch (error) {
        console.error('getInventory error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const addInventory = async (req, res) => {
    const { outlet_id } = req.user;
    const { product_name, category, imei_serial, purchase_price, installment_price } = req.body;

    if (!outlet_id) {
        return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    }

    if (!product_name || !imei_serial || !purchase_price || !installment_price) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    try {
        const existing = await prisma.outletInventory.findUnique({ where: { imei_serial } });
        if (existing) {
            return res.status(400).json({ success: false, message: 'Duplicate EMI/Serial number.' });
        }

        const item = await prisma.outletInventory.create({
            data: {
                outlet_id,
                product_name,
                category,
                imei_serial,
                purchase_price,
                installment_price
            }
        });

        res.status(201).json({ success: true, item });
    } catch (error) {
        console.error('addInventory error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const transferStock = async (req, res) => {
    const { outlet_id } = req.user;
    const { inventory_id, to_type, to_id } = req.body;

    if (!outlet_id || !inventory_id || !to_type || !to_id) {
        return res.status(400).json({ success: false, message: 'Missing fields.' });
    }

    try {
        const item = await prisma.outletInventory.findFirst({
            where: { id: inventory_id, outlet_id }
        });

        if (!item || item.status !== 'In Stock') {
            return res.status(400).json({ success: false, message: 'Item not in stock in your outlet.' });
        }

        const transfer = await prisma.$transaction([
            prisma.stockTransfer.create({
                data: {
                    from_type: 'Outlet',
                    from_id: outlet_id,
                    to_type,
                    to_id,
                    inventory_id
                }
            }),
            prisma.outletInventory.update({
                where: { id: inventory_id },
                data: {
                    status: 'Transferred',
                    outlet_id: to_type === 'Outlet' ? to_id : outlet_id // If transferring to another outlet, reassign. Logic here depends on requirement.
                }
            })
        ]);

        res.json({ success: true, transfer });
    } catch (error) {
        console.error('transferStock error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getInventory,
    addInventory,
    transferStock
};
