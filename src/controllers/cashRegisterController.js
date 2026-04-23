const prisma = require('../../lib/prisma');

const getCashRegister = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    try {
        const registers = await prisma.cashRegister.findMany({
            where: { outlet_id },
            orderBy: { date: 'desc' }
        });
        res.json({ success: true, registers });
    } catch (error) {
        console.error('getCashRegister error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const calculateDailyCash = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // This requires detailed aggregation over the day's payments (downpayments vs installments)
        // and expenses. For now, we will create a skeleton calculation or retrieve the existing one.

        // Simplified view: find today's register or create a new one based on aggregates
        let register = await prisma.cashRegister.findUnique({
            where: {
                outlet_id_date: {
                    outlet_id,
                    date: today
                }
            }
        });

        // Normally here you would run sums on OrderPayment (if tied to this outlet), Expenses, etc.
        // For demonstration, we just return the skeleton or create an empty one.
        if (!register) {
            register = await prisma.cashRegister.create({
                data: {
                    outlet_id,
                    date: today,
                    opening_cash: 0 // Fetch yesterday's closing
                }
            });
        }

        res.json({ success: true, register });

    } catch (error) {
        console.error('calculateDailyCash error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getCashRegister,
    calculateDailyCash
};
