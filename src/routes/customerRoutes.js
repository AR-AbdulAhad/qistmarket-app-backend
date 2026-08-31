const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');
const { getCustomers, getBlacklistedCustomers, getClearedCustomers, getCustomerLedger } = require('../controllers/customerController');
const { getBlacklistStatusForCnic } = require('../controllers/blacklistController');

router.get('/', authenticateJWT, getCustomers);
router.get('/blacklist', authenticateJWT, getBlacklistedCustomers);
router.get('/cleared', authenticateJWT, getClearedCustomers);
router.get('/ledger/:orderRef', authenticateJWT, getCustomerLedger);
router.get('/blacklist-status/:cnic', authenticateJWT, getBlacklistStatusForCnic);

module.exports = router;
