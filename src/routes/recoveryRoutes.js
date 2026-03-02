const express = require('express');
const router = express.Router();
const {
    getAllRecoveryOfficers,
    getRecoveryOfficerStats,
    getRecoveryCustomers,
    markPaymentPaid,
    getCollectionStats,
    getDueOverdueInstallments,
    submitCollections
} = require('../controllers/recoveryController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/officers', authenticateJWT, getAllRecoveryOfficers);
router.get('/officers/:id/stats', authenticateJWT, getRecoveryOfficerStats);

// New Collection Routes
router.get('/customers', authenticateJWT, getRecoveryCustomers);
router.post('/collect', authenticateJWT, markPaymentPaid);
router.get('/collection-stats', authenticateJWT, getCollectionStats);
router.get('/overdue', authenticateJWT, getDueOverdueInstallments);
router.post('/submit-collections', authenticateJWT, submitCollections);

module.exports = router;
