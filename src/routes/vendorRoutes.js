const express = require('express');
const router = express.Router();
const { 
    createPurchase, 
    getPurchases, 
    getPurchaseById, 
    recordPayment, 
    getVendorSummary, 
    getPayments, 
    deletePurchase 
} = require('../controllers/vendorController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/outlet/vendors/purchases', authenticateJWT, getPurchases);
router.post('/outlet/vendors/purchases', authenticateJWT, createPurchase);
router.get('/outlet/vendors/purchases/:id', authenticateJWT, getPurchaseById);
router.delete('/outlet/vendors/purchases/:id', authenticateJWT, deletePurchase);

router.get('/outlet/vendors/payments', authenticateJWT, getPayments);
router.post('/outlet/vendors/payments', authenticateJWT, recordPayment);
router.get('/outlet/vendors/summary', authenticateJWT, getVendorSummary);

module.exports = router;
