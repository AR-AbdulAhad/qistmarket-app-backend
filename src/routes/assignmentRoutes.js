const express = require('express');
const router = express.Router();
const assignmentController = require('../controllers/assignmentController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/officers', authenticateJWT, assignmentController.getOfficerAssignments);
router.put('/:officerId', authenticateJWT, assignmentController.updateOfficerAssignments);

module.exports = router;
