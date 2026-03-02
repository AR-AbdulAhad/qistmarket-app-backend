const express = require('express');
const router = express.Router();
const { getOfficerAssignments, updateOfficerAssignments } = require('../controllers/assignmentController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/officers', authenticateJWT, getOfficerAssignments);
router.put('/:officerId', authenticateJWT, updateOfficerAssignments);

module.exports = router;
