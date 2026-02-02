const express = require('express');
const router = express.Router();
const upload = require('../middlewares/uploadMiddleware');
const fixUploadPath = require('../middlewares/fixUploadPath');
const { authenticateJWT } = require('../middlewares/authMiddleware');

const {
  startVerification,
  savePurchaserVerification,
  saveGrantorVerification,
  saveNextOfKin,
  saveLocation,
  saveVerificationLocation,
  getVerificationLocations,
  deleteVerificationLocation,
  uploadPurchaserDocument,
  uploadGrantorDocument,
  uploadPhoto,
  uploadSignature,
  deleteDocument,
  completeVerification,
  getVerificationByOrderId,
  adminApproveVerification,
  getVerifications
} = require('../controllers/verificationController');

// Get all verifications
router.get('/verifications', authenticateJWT, getVerifications);

// Start verification
router.post('/verification/start', authenticateJWT, startVerification);

// Get verification by order ID
router.get('/verification/order/:order_id', authenticateJWT, getVerificationByOrderId);

// Save verification data
router.post('/verification/:verification_id/purchaser', authenticateJWT, savePurchaserVerification);
router.post('/verification/:verification_id/grantor/:grantor_number', authenticateJWT, saveGrantorVerification);
router.post('/verification/:verification_id/next-of-kin', authenticateJWT, saveNextOfKin);

// Save location (old)
router.post('/verification/:verification_id/location', authenticateJWT, saveLocation);

// NEW: Save verification location with photos
router.post(
  '/verification/:verification_id/location/new',
  authenticateJWT,
  upload.array('photos', 5),
  fixUploadPath,
  saveVerificationLocation
);

// NEW: Get verification locations
router.get('/verification/:verification_id/locations', authenticateJWT, getVerificationLocations);

// NEW: Delete verification location
router.delete('/verification/location/:location_id', authenticateJWT, deleteVerificationLocation);

// Upload purchaser document
router.post(
  '/verification/:verification_id/purchaser/document',
  authenticateJWT,
  upload.single('file'),
  fixUploadPath,
  uploadPurchaserDocument
);

// Upload grantor document
router.post(
  '/verification/:verification_id/grantor/:grantor_number/document',
  authenticateJWT,
  upload.single('file'),
  fixUploadPath,
  uploadGrantorDocument
);

// Upload photo
router.post(
  '/verification/:verification_id/photo',
  authenticateJWT,
  upload.single('file'),
  fixUploadPath,
  uploadPhoto
);

// Upload signature
router.post(
  '/verification/:verification_id/signature',
  authenticateJWT,
  upload.single('file'),
  fixUploadPath,
  uploadSignature
);

// Delete document
router.delete('/verification/document/:document_id', authenticateJWT, deleteDocument);

// Complete verification
router.post('/verification/:verification_id/complete', authenticateJWT, completeVerification);

// Admin approval
router.post('/verification/:verification_id/approve', authenticateJWT, adminApproveVerification);

module.exports = router;