const express = require('express');
const router = express.Router();
const { getExpenses, addExpense } = require('../controllers/expenseController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/outlet/expenses', authenticateJWT, getExpenses);
router.post('/outlet/expenses', authenticateJWT, addExpense);

module.exports = router;
