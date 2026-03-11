const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const getExpenses = async (req, res) => {
    const { outlet_id } = req.user;
    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    try {
        const expenses = await prisma.expense.findMany({ where: { outlet_id } });
        res.json({ success: true, expenses });
    } catch (error) {
        console.error('getExpenses error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const addExpense = async (req, res) => {
    const { outlet_id } = req.user;
    const { expense_type, amount, description } = req.body;

    if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user.' });

    if (!expense_type || !amount) {
        return res.status(400).json({ success: false, message: 'Missing fields' });
    }

    try {
        const expense = await prisma.expense.create({
            data: {
                outlet_id,
                expense_type,
                amount,
                description
            }
        });
        res.status(201).json({ success: true, expense });
    } catch (error) {
        console.error('addExpense error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getExpenses,
    addExpense
};
