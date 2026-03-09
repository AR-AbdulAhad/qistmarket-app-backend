const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');
const { getReportSummary } = require('../controllers/reportController');

router.get('/reports/summary', authenticateJWT, getReportSummary);

module.exports = router;

