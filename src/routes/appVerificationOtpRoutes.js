const express = require('express');
const router = express.Router();

const { sendCode } = require('../controllers/appVerificationOtp');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.post('/send-code', authenticateJWT, sendCode);

module.exports = router;