const express = require('express');
const router = express.Router();
const {
    getExpenses,
    getExpenseById,
    createExpenseVoucher,
    updateExpenseVoucher,
    deleteExpenseVoucher,
    getExpenseSummary
} = require('../controllers/expenseController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/outlet/expenses', authenticateJWT, getExpenses);
router.get('/outlet/expenses/summary', authenticateJWT, getExpenseSummary);
router.get('/outlet/expenses/:id', authenticateJWT, getExpenseById);
router.post('/outlet/expenses', authenticateJWT, createExpenseVoucher);
router.put('/outlet/expenses/:id', authenticateJWT, updateExpenseVoucher);
router.delete('/outlet/expenses/:id', authenticateJWT, deleteExpenseVoucher);

module.exports = router;
