const express = require('express');
const router = express.Router();
const { viewLedger } = require('../controllers/ledgerController');

// Public token-based ledger viewer (no auth middleware)
// GET /api/ledger/:token
router.get('/ledger/:token', viewLedger);

module.exports = router;
