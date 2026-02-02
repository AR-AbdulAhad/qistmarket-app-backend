const express = require('express');
const router = express.Router();
const { 
  createOrder, 
  getOrders, 
  getOrdersWithPagination,
  assignOrder, 
  assignBulk, 
  getOrderById,
  getVerificationOrders
} = require('../controllers/ordersController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/orders/verification-pending', getVerificationOrders);
router.post('/orders/create', authenticateJWT, createOrder);
router.get('/orders', authenticateJWT, getOrders);
router.get('/orders/scroll', getOrdersWithPagination);
router.patch('/orders/:id/assign', authenticateJWT, assignOrder);
router.post('/orders/assign-bulk', authenticateJWT, assignBulk);
router.get('/orders/:id', authenticateJWT, getOrderById);

module.exports = router;