const express = require('express');
const router = express.Router();
const { getCities, createCity, updateCity, deleteCity, getZones, createZone, updateZone, deleteZone, getAreas, createArea, updateArea, deleteArea, getAddressHierarchy, bulkUploadAddresses } = require('../controllers/addressController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/cities', authenticateJWT, getCities);
router.post('/cities', authenticateJWT, createCity);
router.put('/cities/:id', authenticateJWT, updateCity);
router.delete('/cities/:id', authenticateJWT, deleteCity);

router.get('/zones', authenticateJWT, getZones);
router.post('/zones', authenticateJWT, createZone);
router.put('/zones/:id', authenticateJWT, updateZone);
router.delete('/zones/:id', authenticateJWT, deleteZone);

router.get('/areas', authenticateJWT, getAreas);
router.post('/areas', authenticateJWT, createArea);
router.put('/areas/:id', authenticateJWT, updateArea);
router.delete('/areas/:id', authenticateJWT, deleteArea);

router.get('/hierarchy', authenticateJWT, getAddressHierarchy);
router.post('/bulk-upload', authenticateJWT, bulkUploadAddresses);

module.exports = router;
