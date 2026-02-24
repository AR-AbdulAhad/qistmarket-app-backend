const express = require('express');
const router = express.Router();
const {
  createOrder,
  getOrders,
  getOrdersWithPagination,
  assignOrder,
  assignBulk,
  getOrderById,
  getVerificationOrders,
  getMyDeliveryOrdersWithPagination,
  getApprovedOrders,
  assignDelivery,
  assignBulkDelivery,
  cancelOrder,
  updateOrderItem
} = require('../controllers/ordersController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/orders/verification-pending', getVerificationOrders);
router.get('/orders/delivery-pending', authenticateJWT, getApprovedOrders);
router.post('/orders/create', authenticateJWT, createOrder);
router.get('/orders', authenticateJWT, getOrders);
router.get('/orders/scroll', authenticateJWT, getOrdersWithPagination);
router.get('/orders/deliver/scroll', authenticateJWT, getMyDeliveryOrdersWithPagination);
router.patch('/orders/:id/assign', authenticateJWT, assignOrder);
router.post('/orders/assign-bulk', authenticateJWT, assignBulk);
router.get('/orders/:id', authenticateJWT, getOrderById);
router.patch('/orders/:id/assign-delivery', authenticateJWT, assignDelivery);
router.post('/orders/assign-bulk-delivery', authenticateJWT, assignBulkDelivery);
router.patch('/orders/:id/cancel', authenticateJWT, cancelOrder);
router.patch('/orders/:id/update-item', authenticateJWT, updateOrderItem);

module.exports = router;