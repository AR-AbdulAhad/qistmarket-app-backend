const express = require('express');
const router = express.Router();
const {
    viewLedger,
    downloadLedgerPdf,
    generateInstallmentPaymentOtp,
    verifyInstallmentPaymentOtp
} = require('../controllers/ledgerController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

// New: short ID based PDF download — GET /api/ledger/pdf/:shortId
router.get('/pdf/:shortId', downloadLedgerPdf);

// Legacy: JWT token based HTML view — GET /api/ledger/:token
router.get('/:token', viewLedger);

// Installment Payment flows (Outlet Managers)
router.post('/generate-payment-otp', authenticateJWT, generateInstallmentPaymentOtp);
router.post('/verify-payment-and-pay', authenticateJWT, verifyInstallmentPaymentOtp);

module.exports = router;
