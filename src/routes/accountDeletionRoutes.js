const express = require('express');
const router = express.Router();
const { authenticateJWT, authorizeRoles } = require('../middlewares/authMiddleware');
const {
    requestAccountDeletion,
    getMyDeletionRequest,
    getAllDeletionRequests,
    reviewDeletionRequest,
} = require('../controllers/accountDeletionController');

// Self-service — any authenticated user
router.post('/account/deletion-request', authenticateJWT, requestAccountDeletion);
router.get('/account/deletion-request', authenticateJWT, getMyDeletionRequest);

// Admin review
router.get('/admin/deletion-requests', authenticateJWT, authorizeRoles('Admin', 'Super Admin'), getAllDeletionRequests);
router.patch('/admin/deletion-requests/:id/review', authenticateJWT, authorizeRoles('Admin', 'Super Admin'), reviewDeletionRequest);

module.exports = router;
