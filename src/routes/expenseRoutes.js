const express = require('express');
const router = express.Router();
const { 
    getExpenses, 
    createExpenseVoucher, 
    deleteExpenseVoucher, 
    getExpenseSummary 
} = require('../controllers/expenseController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/outlet/expenses', authenticateJWT, getExpenses);
router.post('/outlet/expenses', authenticateJWT, createExpenseVoucher);
router.delete('/outlet/expenses/:id', authenticateJWT, deleteExpenseVoucher);
router.get('/outlet/expenses/summary', authenticateJWT, getExpenseSummary);

module.exports = router;
