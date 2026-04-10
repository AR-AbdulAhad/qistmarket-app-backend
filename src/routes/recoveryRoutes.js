const express = require('express');
const router = express.Router();
const {
    getAllRecoveryOfficers,
    getRecoveryOfficerStats,
    getRecoveryCustomers,
    getCollectionStats,
    getDueOverdueInstallments,
    submitCollections,
    generateInstallmentOtp,
    verifyAndSubmitInstallment,
    logRecoveryVisit
} = require('../controllers/recoveryController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/officers', authenticateJWT, getAllRecoveryOfficers);
router.get('/officers/:id/stats', authenticateJWT, getRecoveryOfficerStats);

// Collection Routes
router.get('/customers', authenticateJWT, getRecoveryCustomers);
router.get('/collection-stats', authenticateJWT, getCollectionStats);
router.get('/overdue', authenticateJWT, getDueOverdueInstallments);
router.post('/submit-collections', authenticateJWT, submitCollections);

// Installment Payment flows (Recovery Officers) — same as outlet pattern
router.post('/installment/generate-otp', authenticateJWT, generateInstallmentOtp);
router.post('/submit-installment', authenticateJWT, verifyAndSubmitInstallment);

// Visit Logging Route (without payment)
router.post('/visit', authenticateJWT, logRecoveryVisit);

module.exports = router;

