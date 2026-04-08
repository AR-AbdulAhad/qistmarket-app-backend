const express = require('express');
const router = express.Router();
const { viewLedger, downloadLedgerPdf } = require('../controllers/ledgerController');

// New: short ID based PDF download — GET /api/ledger/pdf/:shortId
router.get('/pdf/:shortId', downloadLedgerPdf);

// Legacy: JWT token based HTML view — GET /api/ledger/:token
router.get('/:token', viewLedger);

module.exports = router;
