const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');
const { getCustomers, getBlacklistedCustomers, getClearedCustomers } = require('../controllers/customerController');

router.get('/', authenticateJWT, getCustomers);
router.get('/blacklist', authenticateJWT, getBlacklistedCustomers);
router.get('/cleared', authenticateJWT, getClearedCustomers);

module.exports = router;
