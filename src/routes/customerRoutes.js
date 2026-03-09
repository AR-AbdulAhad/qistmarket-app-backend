const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');
const { getCustomers } = require('../controllers/customerController');

router.get('/', authenticateJWT, getCustomers);

module.exports = router;
