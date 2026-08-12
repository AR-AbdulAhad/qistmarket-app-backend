const express = require('express');
const router = express.Router();
const { getCashRegister, getCashRegisterHistory, calculateDailyCash, submitReconciliation, approveRegister, reopenRegister } = require('../controllers/cashRegisterController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/outlet/cash-register', authenticateJWT, getCashRegister);
router.get('/outlet/cash-register/history', authenticateJWT, getCashRegisterHistory);
router.post('/outlet/cash-register/calculate', authenticateJWT, calculateDailyCash);
router.post('/outlet/cash-register/reconcile', authenticateJWT, submitReconciliation);
router.post('/outlet/cash-register/approve', authenticateJWT, approveRegister);
router.post('/outlet/cash-register/reopen', authenticateJWT, reopenRegister);

module.exports = router;
