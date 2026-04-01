const express = require('express');
const router = express.Router();
const { createComplaint, getComplaints } = require('../controllers/complaintController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/', authenticateJWT, getComplaints);
router.post('/', authenticateJWT, createComplaint);

module.exports = router;
