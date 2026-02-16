const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/authMiddleware');

const {
  getDeliveryBoysOverview,
  getDeliveryBoyDetails,
  generatePickupOtp,
  verifyPickupOtp
} = require('../controllers/deliveryManagementController');


router.get('/delivery-management/dashboard', getDeliveryBoysOverview);
router.get('/delivery-management/boy/:boyId/details', getDeliveryBoyDetails);
router.post('/delivery-management/generate-pickup-otp', generatePickupOtp);
router.post('/delivery-management/verify-pickup-otp', verifyPickupOtp);

module.exports = router;