const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');

const {
  getAllVerificationOfficers,
  updateOfficerProfile,
  getMyOfficerStatus,
} = require('../controllers/officerController');

// Admin only - Full officer list with live data
router.get('/officers', authenticateJWT, getAllVerificationOfficers);

// Officer only - Update bike range & working hours
router.put('/officer/profile', authenticateJWT, updateOfficerProfile);

// Officer only - Get own online/location status (for Flutter dashboard)
router.get('/officer/status', authenticateJWT, getMyOfficerStatus);

module.exports = router;