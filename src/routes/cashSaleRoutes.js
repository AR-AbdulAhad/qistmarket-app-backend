const express = require('express');
const router = express.Router();
const { createCashSale, getCashSaleHistory } = require('../controllers/cashSaleController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

// Note: the Cash Sale product picker reuses the existing
// GET /api/outlet/inventory (Stock List) endpoint directly instead of a
// separate one here, so the two screens can never show different stock.

router.get('/outlet/cash-sale/history', authenticateJWT, getCashSaleHistory);
router.post('/outlet/cash-sale', authenticateJWT, createCashSale);

module.exports = router;
