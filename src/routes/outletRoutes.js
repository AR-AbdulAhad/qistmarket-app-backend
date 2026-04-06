const express = require('express');
const router = express.Router();
const {
    createOutlet,
    getOutlets,
    getAllOutlets,
    updateOutlet,
    loginOutletUser,
    getDashboardStats,
    getGlobalCashInHand,
    verifyCashSubmissionOTP,
    getOutletCashHistory,
    getReturnExchanges,
    verifyReturnExchangeOtp
} = require('../controllers/outletController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.post('/outlets', authenticateJWT, createOutlet);
router.get('/outlets', authenticateJWT, getOutlets);
router.get('/all-outlets', authenticateJWT, getAllOutlets);
router.patch('/outlets/:id', authenticateJWT, updateOutlet);
router.post('/outlet/login', loginOutletUser);
router.get('/outlet/dashboard-stats', authenticateJWT, getDashboardStats);

// Cash handling routes
router.post('/outlet/verify-cash-otp', authenticateJWT, verifyCashSubmissionOTP);
router.get('/outlet/global-cash-in-hand', authenticateJWT, getGlobalCashInHand);
router.get('/outlet/cash-history', authenticateJWT, getOutletCashHistory);

// Return and Exchange Module
router.get('/outlet/return-exchanges', authenticateJWT, getReturnExchanges);
router.post('/outlet/verify-return-otp', authenticateJWT, verifyReturnExchangeOtp);

module.exports = router;
