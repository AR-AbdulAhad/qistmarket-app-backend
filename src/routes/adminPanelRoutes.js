const express = require('express');
const router = express.Router();
const { authenticateJWT, requireSuperAdmin } = require('../middlewares/authMiddleware');
const { getUsers } = require('../controllers/authController');
const {
    getOutletPerformanceSummary, getUnifiedRankings, getDeliveryManagementOverview, syncBadges, getBadges,
    getOutletRankings, getMissedRecoveryTracking, getProductSalesReport, getInstallmentStatusCounts,
    getAttendanceMonitoring, getPayrollSummary, getOutletStaffList, deleteOrderPermanently,
    listRecycleBinOrders, restoreOrders, permanentlyDeleteOrders,
    getScoringRulesConfig, updateScoringRulesConfig, triggerRankingsRecalculation,
} = require('../controllers/adminPanelController');
const { sendBroadcast, getRoleOptions } = require('../controllers/broadcastController');
const { commitLegacyImport, listPendingLegacyProfiles, markLegacyProfileComplete } = require('../controllers/legacyImportController');
const { getOtpChannelSettings, updateOtpChannelSettings } = require('../controllers/settingsController');

router.get('/users', authenticateJWT, requireSuperAdmin, getUsers);
router.get('/settings/otp', authenticateJWT, requireSuperAdmin, getOtpChannelSettings);
router.post('/settings/otp', authenticateJWT, requireSuperAdmin, updateOtpChannelSettings);
router.get('/scoring-rules', authenticateJWT, getScoringRulesConfig);
router.post('/scoring-rules', authenticateJWT, requireSuperAdmin, updateScoringRulesConfig);
router.post('/scoring-rules/recalculate', authenticateJWT, requireSuperAdmin, triggerRankingsRecalculation);
router.delete('/orders/:orderId/permanent-delete', authenticateJWT, requireSuperAdmin, deleteOrderPermanently);
router.get('/orders/recycle-bin', authenticateJWT, requireSuperAdmin, listRecycleBinOrders);
router.post('/orders/recycle-bin/restore', authenticateJWT, requireSuperAdmin, restoreOrders);
router.post('/orders/recycle-bin/permanent-delete', authenticateJWT, requireSuperAdmin, permanentlyDeleteOrders);
router.post('/legacy-import/commit', authenticateJWT, requireSuperAdmin, commitLegacyImport);
router.get('/legacy-import/pending', authenticateJWT, requireSuperAdmin, listPendingLegacyProfiles);
router.post('/legacy-import/:orderId/mark-complete', authenticateJWT, requireSuperAdmin, markLegacyProfileComplete);
router.get('/outlets/performance', authenticateJWT, getOutletPerformanceSummary);
router.get('/outlets/rankings', authenticateJWT, getOutletRankings);
router.get('/rankings', authenticateJWT, getUnifiedRankings);
router.get('/delivery-overview', authenticateJWT, getDeliveryManagementOverview);
router.post('/notifications/broadcast', authenticateJWT, sendBroadcast);
router.get('/roles', authenticateJWT, getRoleOptions);
router.post('/badges/sync', authenticateJWT, syncBadges);
router.get('/badges', authenticateJWT, getBadges);
router.get('/recovery/missed', authenticateJWT, getMissedRecoveryTracking);
router.get('/reports/product-sales', authenticateJWT, getProductSalesReport);
router.get('/installments/status-counts', authenticateJWT, getInstallmentStatusCounts);
router.get('/attendance', authenticateJWT, getAttendanceMonitoring);
router.get('/reports/payroll', authenticateJWT, getPayrollSummary);
router.get('/outlets/staff', authenticateJWT, getOutletStaffList);

module.exports = router;


