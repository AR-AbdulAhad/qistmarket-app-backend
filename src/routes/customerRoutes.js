const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');
const { getCustomers, getBlacklistedCustomers, getClearedCustomers, getCustomerLedger } = require('../controllers/customerController');
const { getBlacklistStatusForCnic } = require('../controllers/blacklistController');

router.get('/', authenticateJWT, getCustomers);
// Every portal may view its scoped blacklist records. Only the whitelist
// action itself is restricted by the Accounts routes and middleware.
router.get('/blacklist', authenticateJWT, getBlacklistedCustomers);
router.get('/cleared', authenticateJWT, getClearedCustomers);
router.get('/ledger/:orderRef', authenticateJWT, getCustomerLedger);
router.get('/blacklist-status/:cnic', authenticateJWT, getBlacklistStatusForCnic);

module.exports = router;
