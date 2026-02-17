const express = require('express');
const router = express.Router();
const upload = require('../middlewares/uploadMiddleware');
const fixUploadPath = require('../middlewares/fixUploadPath');

const {
  // OTP Login functions
  sendLoginOTP,
  verifyLoginOTP,
  
  // Existing functions
  signup,
  loginWeb,
  loginApp,
  toggleUserStatus,
  getUsers,
  editUser,
  updateUserPermissions,
  deleteUser,
  getMe,
  updateProfile,
  getVerificationOfficers,
  forgotPassword,
  resetPassword,
  getDeliveryOfficers
} = require('../controllers/authController');

const { authenticateJWT, requireSuperAdmin } = require('../middlewares/authMiddleware');

// ==================== PUBLIC ROUTES ====================

// OTP Login Routes (NO AUTHENTICATION REQUIRED)
router.post('/login/send-otp', sendLoginOTP);        // Step 1: Send OTP
router.post('/login/verify-otp', verifyLoginOTP);    // Step 2: Verify OTP & Login

// Password-based login (keep for backward compatibility)
router.post('/login/web', loginWeb);
router.post('/login/app', loginApp);

// Password reset routes
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

// ==================== PROTECTED ROUTES ====================

// User profile routes
router.get('/user/me', authenticateJWT, getMe);
router.post(
  '/user/update',
  authenticateJWT,
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'coverImage', maxCount: 1 }]),
  fixUploadPath,
  updateProfile
);

// Utility routes
router.get('/users/verification-officers', authenticateJWT, getVerificationOfficers);
router.get('/users/delivery-officers', authenticateJWT, getDeliveryOfficers);

// ==================== SUPER ADMIN ROUTES ====================

router.post('/signup', authenticateJWT, requireSuperAdmin, signup);
router.get('/users', authenticateJWT, requireSuperAdmin, getUsers);
router.patch('/users/:userId/status', authenticateJWT, requireSuperAdmin, toggleUserStatus);
router.patch(
  '/users/:userId/edit', 
  authenticateJWT, 
  requireSuperAdmin,
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'coverImage', maxCount: 1 }]),
  fixUploadPath, 
  editUser
);
router.patch('/users/:userId/permissions', authenticateJWT, requireSuperAdmin, updateUserPermissions);
router.delete('/users/:userId', authenticateJWT, requireSuperAdmin, deleteUser);

module.exports = router;