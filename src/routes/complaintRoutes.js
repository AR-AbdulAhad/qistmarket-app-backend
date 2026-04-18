const express = require('express');
const router = express.Router();
const { createComplaint, getComplaints, updateComplaint } = require('../controllers/complaintController');
const { authenticateJWT } = require('../middlewares/authMiddleware');
const upload = require('../middlewares/uploadMiddleware');
const fixUploadPath = require('../middlewares/fixUploadPath');

router.get('/complaints', authenticateJWT, getComplaints);
router.post('/complaints', authenticateJWT, upload.array('media', 5), fixUploadPath, createComplaint);
router.put('/complaints/:id', authenticateJWT, updateComplaint);

module.exports = router;
