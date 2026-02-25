const express = require('express');
const router = express.Router();
const addressController = require('../controllers/addressController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/cities', authenticateJWT, addressController.getCities);
router.post('/cities', authenticateJWT, addressController.createCity);
router.put('/cities/:id', authenticateJWT, addressController.updateCity);
router.delete('/cities/:id', authenticateJWT, addressController.deleteCity);

router.get('/zones', authenticateJWT, addressController.getZones);
router.post('/zones', authenticateJWT, addressController.createZone);
router.put('/zones/:id', authenticateJWT, addressController.updateZone);
router.delete('/zones/:id', authenticateJWT, addressController.deleteZone);

router.get('/areas', authenticateJWT, addressController.getAreas);
router.post('/areas', authenticateJWT, addressController.createArea);
router.put('/areas/:id', authenticateJWT, addressController.updateArea);
router.delete('/areas/:id', authenticateJWT, addressController.deleteArea);

router.get('/hierarchy', authenticateJWT, addressController.getAddressHierarchy);
router.post('/bulk-upload', authenticateJWT, addressController.bulkUploadAddresses);

module.exports = router;
