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
  getApprovedOrders,
  assignDelivery,
  assignBulkDelivery,
  cancelOrder,
  updateOrderItem,
  getDeliveryStatus,
  getDeliveredOrders,
  assignRecovery,
  assignBulkRecovery,
  getMyDeliveryOrdersWithPagination
} = require('../controllers/ordersController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

// Recovery Related Order Routes (Specific routes first)
router.get('/orders/delivered-list', authenticateJWT, getDeliveredOrders);
router.patch('/orders/:id/assign-recovery', authenticateJWT, assignRecovery);
router.post('/orders/assign-bulk-recovery', authenticateJWT, assignBulkRecovery);

// Standard Order Routes
router.get('/orders/verification-pending', getVerificationOrders);
router.get('/orders/delivery-pending', authenticateJWT, getApprovedOrders);
router.get('/orders/delivery-status', authenticateJWT, getDeliveryStatus);
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