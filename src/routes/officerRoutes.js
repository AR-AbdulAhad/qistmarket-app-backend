const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');

const {
  getAllVerificationOfficers,
  updateOfficerProfile,
  getMyOfficerStatus,
  getOfficerDailyStats,
} = require('../controllers/officerController');

router.get('/officers', authenticateJWT, getAllVerificationOfficers);
router.put('/officer/profile', authenticateJWT, updateOfficerProfile);
router.get('/officer/status', authenticateJWT, getMyOfficerStatus);
router.get('/officers/:id/stats', authenticateJWT, getOfficerDailyStats);

module.exports = router;