const express = require('express');
const router = express.Router();
const { getSecurityLogs } = require('../controllers/securityLogController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/', authenticateJWT, getSecurityLogs);

module.exports = router;
