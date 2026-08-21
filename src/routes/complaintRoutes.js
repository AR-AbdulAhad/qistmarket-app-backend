const express = require('express');
const router = express.Router();
const {
  createComplaint,
  getComplaints,
  getComplaintById,
  updateComplaint,
  searchPurchasers,
  pickComplaint,
  linkComplaintToOrder,
  trackComplaint,
  searchPublicComplaints,
} = require('../controllers/complaintController');
const { authenticateJWT } = require('../middlewares/authMiddleware');
const upload = require('../middlewares/uploadMiddleware');
const fixUploadPath = require('../middlewares/fixUploadPath');

router.get('/complaints', authenticateJWT, getComplaints);
router.get('/complaints/search-purchasers', authenticateJWT, searchPurchasers);
router.get('/complaints/track/:complaintId', trackComplaint);
router.get('/complaints/public/search', searchPublicComplaints);
// Must come after the literal GET routes above — otherwise :id would shadow
// them (e.g. "search-purchasers" would be parsed as an id).
router.get('/complaints/:id', authenticateJWT, getComplaintById);
router.post('/complaints', authenticateJWT, upload.array('media', 5), fixUploadPath, createComplaint);
router.post('/complaints/public', upload.array('media', 5), fixUploadPath, createComplaint);
router.put('/complaints/:id', authenticateJWT, updateComplaint);
router.put('/complaints/:id/pick', authenticateJWT, pickComplaint);
router.put('/complaints/:id/link', authenticateJWT, linkComplaintToOrder);

module.exports = router;
