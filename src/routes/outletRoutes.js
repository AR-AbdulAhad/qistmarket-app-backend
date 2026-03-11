const express = require('express');
const router = express.Router();
const { createOutlet, getOutlets, updateOutlet, loginOutletUser, getDashboardStats } = require('../controllers/outletController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.post('/outlets', authenticateJWT, createOutlet);
router.get('/outlets', authenticateJWT, getOutlets);
router.patch('/outlets/:id', authenticateJWT, updateOutlet);
router.post('/outlet/login', loginOutletUser);
router.get('/outlet/dashboard-stats', authenticateJWT, getDashboardStats);

module.exports = router;
