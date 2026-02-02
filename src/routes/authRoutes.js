const express = require('express');
const router = express.Router();
const upload = require('../middlewares/uploadMiddleware');
const fixUploadPath = require('../middlewares/fixUploadPath');

const {
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
} = require('../controllers/authController');

const { authenticateJWT, requireSuperAdmin } = require('../middlewares/authMiddleware');

router.post('/login/web', loginWeb);
router.post('/login/app', loginApp);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

router.get('/user/me', authenticateJWT, getMe);
router.post(
  '/user/update',
  authenticateJWT,
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'coverImage', maxCount: 1 }]),
  fixUploadPath,
  updateProfile
);

router.get('/users/verification-officers', authenticateJWT, getVerificationOfficers);

router.post('/signup', authenticateJWT, requireSuperAdmin, signup);
router.get('/users', authenticateJWT, requireSuperAdmin, getUsers);
router.patch('/users/:userId/status', authenticateJWT, requireSuperAdmin, toggleUserStatus);
router.patch('/users/:userId/edit', authenticateJWT, requireSuperAdmin,
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'coverImage', maxCount: 1 }]),
  fixUploadPath, editUser);
router.patch('/users/:userId/permissions', authenticateJWT, requireSuperAdmin, updateUserPermissions);
router.delete('/users/:userId', authenticateJWT, requireSuperAdmin, deleteUser);

module.exports = router;