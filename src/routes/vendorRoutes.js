const express = require('express');
const router = express.Router();
const { getVendorPurchases, addVendorPurchase, getVendorPayments, addVendorPayment } = require('../controllers/vendorController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/outlet/vendors/purchases', authenticateJWT, getVendorPurchases);
router.post('/outlet/vendors/purchases', authenticateJWT, addVendorPurchase);
router.get('/outlet/vendors/payments', authenticateJWT, getVendorPayments);
router.post('/outlet/vendors/payments', authenticateJWT, addVendorPayment);

module.exports = router;
