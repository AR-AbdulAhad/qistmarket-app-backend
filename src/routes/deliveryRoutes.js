const express = require('express');
const router = express.Router();
const upload = require('../middlewares/uploadMiddleware');
const fixUploadPath = require('../middlewares/fixUploadPath');
const { authenticateJWT } = require('../middlewares/authMiddleware');

const {
  submitDelivery,
  getDeliveryByOrderId,
  getPendingDeliveryProducts,
  getCashInHand
} = require('../controllers/deliveryController');

// Submit delivery (batch)
router.post(
  '/delivery/submit',
  authenticateJWT,
  upload.fields([
    { name: 'face_photos', maxCount: 5 },
    { name: 'location_photos', maxCount: 5 },
    { name: 'house_photos', maxCount: 5 }
  ]),
  fixUploadPath,
  submitDelivery
);

// Get delivery by order ID
router.get('/delivery/order/:order_id', getDeliveryByOrderId);
router.get('/delivery-boy/picked-products-minimal', authenticateJWT, getPendingDeliveryProducts);
router.get('/delivery-boy/cash-in-hand', getCashInHand);

module.exports = router;