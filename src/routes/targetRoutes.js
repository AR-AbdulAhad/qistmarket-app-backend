const express = require('express');
const router = express.Router();
const { getTargets, assignTarget } = require('../controllers/targetController');
const { authenticateJWT, authorizeRoles } = require('../middlewares/authMiddleware');

router.get('/officer', authenticateJWT, authorizeRoles('Admin', 'Super Admin', 'Branch User'), getTargets);
router.post('/officer', authenticateJWT, authorizeRoles('Admin', 'Super Admin', 'Branch User'), assignTarget);

module.exports = router;
