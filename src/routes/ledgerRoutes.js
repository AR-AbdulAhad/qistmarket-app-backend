const express = require('express');
const router = express.Router();
const {
    viewLedger,
    downloadLedgerPdf,
    generateInstallmentPaymentOtp,
    verifyInstallmentPaymentOtp,
    sendLedgerToCustomer,
    editLedgerRows,
    setLedgerMonths,
    rebuildOrderLedger
} = require('../controllers/ledgerController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

// New: short ID based PDF download — GET /api/ledger/pdf/:shortId
router.get('/pdf/:shortId', downloadLedgerPdf);

// Legacy: JWT token based HTML view — GET /api/ledger/:token
router.get('/:token', viewLedger);

// Installment Payment flows (Outlet Managers)
router.post('/generate-payment-otp', authenticateJWT, generateInstallmentPaymentOtp);
router.post('/verify-payment-and-pay', authenticateJWT, verifyInstallmentPaymentOtp);

// Send Ledger via WhatsApp
router.post('/:shortId/send', authenticateJWT, sendLedgerToCustomer);

// Admin-direct ledger correction (Super Admin only, enforced in the controller)
router.patch('/:ledger_id/edit', authenticateJWT, editLedgerRows);
router.post('/:ledger_id/set-months', authenticateJWT, setLedgerMonths);

// Repair a delivered order whose ledger was never created (Super Admin only)
router.post('/rebuild/:order_id', authenticateJWT, rebuildOrderLedger);

module.exports = router;
