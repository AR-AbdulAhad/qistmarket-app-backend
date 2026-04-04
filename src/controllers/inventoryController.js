const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { notifyUser, notifyAdmins } = require('../utils/notificationUtils');
const { sendOTP } = require('../services/watiService');

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
            const { product_name, category, imei_serial, purchase_price, status } = item;

            if (!product_name || !imei_serial || purchase_price === undefined) {
                continue;
            }

            const existing = await prisma.outletInventory.findUnique({ where: { imei_serial } });
            if (existing) {
                continue; 
            }

            const created = await prisma.outletInventory.create({
                data: {
                    outlet_id,
                    product_name,
                    category: category || '',
                    imei_serial,
                    purchase_price: parseFloat(purchase_price),
                    installment_price: 0, 
                    status: status || 'In Stock'
                }
            });
            createdItems.push(created);
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

        if (to_type === 'Delivery Officer') {
            const doUser = await prisma.user.findFirst({
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

        const items = await prisma.outletInventory.findMany({
            where: { id: { in: inventory_ids }, outlet_id, status: 'In Stock' }
        });

        if (items.length !== inventory_ids.length) {
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

        // Use WATI to dispatch the OTP message via WhatsApp
        await sendOTP(recipientPhone, otp);

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

        const items = await prisma.outletInventory.findMany({
            where: { id: { in: inventory_ids }, outlet_id, status: 'In Stock' }
        });

        if (items.length !== inventory_ids.length) {
            return res.status(400).json({ success: false, message: 'Some items could not be found or are not in stock.' });
        }

        // Process transfers
        const transfers = await prisma.$transaction(async (tx) => {
            // "or transfere karne ke bd stsus transfered hojata hay or stock transfere list me se hat jata hay jb ke usi me rahe or koi status chaneg na ho sahi hay"
            let payload = { status: 'In Stock' }; 
            
            // Note: If transferring to another Outlet, it must physically reflect in their inventory ID
            if (to_type === 'Outlet') {
                payload = { status: 'In Stock', outlet_id: targetId };
            }

            // Bulk update inventory status (Only applies outlet_id swap if Outlet)
            await tx.outletInventory.updateMany({
                where: { id: { in: inventory_ids } },
                data: payload
            });

            // Bulk create transfer records
            const transferData = inventory_ids.map(id => ({
                from_type: 'Outlet',
                from_id: outlet_id,
                to_type,
                to_id: targetId,
                inventory_id: id
            }));

            await tx.stockTransfer.createMany({
                data: transferData
            });

            // Mark OTP as used
            await tx.otp.update({
                where: { id: otpRecord.id },
                data: { isUsed: true }
            });

            return transferData; // returning the payload structure
        }, { timeout: 15000 }); // extended timeout 15s

        // Notifications
        const messageTitle = 'Stock Transfer Received';
        const messageBody = `You have received a transfer of ${items.length} item(s) from Outlet ${outlet_id}.`;
        const io = req.app.get('io');

        if (to_type === 'Delivery Officer') {
            await notifyUser(targetId, messageTitle, messageBody, 'stock_transfer', null, io);
        } else if (to_type === 'Outlet') {
            // Find users associated with the target outlet (usually Branch Users)
            const targetUsers = await prisma.user.findMany({
                where: { outlet_id: targetId, role: { name: 'Branch User' }, status: 'active' }
            });
            for (const usr of targetUsers) {
                await notifyUser(usr.id, messageTitle, messageBody, 'stock_transfer', null, io);
            }
        }

        // Notify Admins mapping (dashboard global alerts)
        await notifyAdmins('Outlet Stock Transferred', `${items.length} items transferred from Outlet ${outlet_id} to ${to_type} ${targetId}`, 'stock_transfer', null, io);

        res.json({ success: true, transfers });
    } catch (error) {
        console.error('verifyStockTransfer error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getTransferHistory = async (req, res) => {
    const { outlet_id } = req.user;

    if (!outlet_id) {
        return res.status(403).json({ success: false, message: 'Not an outlet user.' });
    }

    try {
        const transfers = await prisma.stockTransfer.findMany({
            where: { from_type: 'Outlet', from_id: outlet_id },
            include: {
                inventory: true
            },
            orderBy: { created_at: 'desc' }
        });

        // We also need to map the "to_id" to human readable names.
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

        res.json({ success: true, count: mappedTransfers.length, transfers: mappedTransfers });
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
    bulkDeleteInventory
};
