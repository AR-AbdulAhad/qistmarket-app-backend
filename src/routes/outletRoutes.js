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
    verifyReturnExchangeOtp,
    initiateDirectReturn,
    searchDeliveredOrders,
    getOutletInstallments,
    generateInstallmentOtp,
    verifyInstallmentPayment
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
router.get('/outlet/search-delivered-orders', authenticateJWT, searchDeliveredOrders);
router.post('/outlet/initiate-direct-return', authenticateJWT, initiateDirectReturn);
router.get('/outlet/installments', authenticateJWT, getOutletInstallments);

// Installment Payment flows (Outlet Managers)
router.post('/outlet/installment/generate-otp', authenticateJWT, generateInstallmentOtp);
router.post('/outlet/installment/verify-and-pay', authenticateJWT, verifyInstallmentPayment);

module.exports = router;
