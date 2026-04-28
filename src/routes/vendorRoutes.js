const express = require('express');
const router = express.Router();
const { 
    createPurchase, 
    getPurchases, 
    getPurchaseById, 
    updatePurchase,
    getPurchaseHistory,
    recordPayment, 
    getVendorSummary, 
    getPayments, 
    deletePurchase,
    getVendors,
    createVendor,
    updateVendor,
    getVendorLedger,
    createPurchaseReturn,
    getPurchaseReturns
} = require('../controllers/vendorController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/outlet/vendors', authenticateJWT, getVendors);
router.post('/outlet/vendors', authenticateJWT, createVendor);
router.patch('/outlet/vendors/:id', authenticateJWT, updateVendor);
router.get('/outlet/vendors/ledger/:id', authenticateJWT, getVendorLedger);

router.get('/outlet/vendors/purchases', authenticateJWT, getPurchases);
router.post('/outlet/vendors/purchases', authenticateJWT, createPurchase);
router.get('/outlet/vendors/purchases/:id', authenticateJWT, getPurchaseById);
router.put('/outlet/vendors/purchases/:id', authenticateJWT, updatePurchase);
router.get('/outlet/vendors/purchases/:id/history', authenticateJWT, getPurchaseHistory);
router.delete('/outlet/vendors/purchases/:id', authenticateJWT, deletePurchase);

router.get('/outlet/vendors/payments', authenticateJWT, getPayments);
router.post('/outlet/vendors/payments', authenticateJWT, recordPayment);
router.get('/outlet/vendors/summary', authenticateJWT, getVendorSummary);

router.get('/outlet/vendors/returns', authenticateJWT, getPurchaseReturns);
router.post('/outlet/vendors/returns', authenticateJWT, createPurchaseReturn);

module.exports = router;
