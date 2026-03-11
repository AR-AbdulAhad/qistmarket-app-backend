const express = require('express');
const router = express.Router();
const { getCashRegister, calculateDailyCash } = require('../controllers/cashRegisterController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/outlet/cash-register', authenticateJWT, getCashRegister);
router.post('/outlet/cash-register/calculate', authenticateJWT, calculateDailyCash);

module.exports = router;
