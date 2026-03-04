const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');

const {
  getDeliveryBoysOverview,
  getDeliveryBoyDetails,
  generatePickupOtp,
  verifyPickupOtp,
  getDeliveryBoyStats
} = require('../controllers/deliveryManagementController');


router.get('/delivery-management/dashboard', getDeliveryBoysOverview);
router.get('/delivery-management/boy/:boyId/details', getDeliveryBoyDetails);
router.get('/delivery-management/boy/:id/stats', getDeliveryBoyStats);
router.post('/delivery-management/generate-pickup-otp', generatePickupOtp);
router.post('/delivery-management/verify-pickup-otp', verifyPickupOtp);

module.exports = router;