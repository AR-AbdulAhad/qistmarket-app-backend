const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');

const {
    getNotifications,
    markAsRead,
    markAllAsRead,
} = require('../controllers/notificationController');

router.get('/notifications', authenticateJWT, getNotifications);
router.patch('/notifications/:id/read', authenticateJWT, markAsRead);
router.patch('/notifications/read-all', authenticateJWT, markAllAsRead);

module.exports = router;
