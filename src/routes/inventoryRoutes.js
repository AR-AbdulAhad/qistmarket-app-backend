const express = require('express');
const router = express.Router();
const { getInventory, addInventory, transferStock } = require('../controllers/inventoryController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/outlet/inventory', authenticateJWT, getInventory);
router.post('/outlet/inventory', authenticateJWT, addInventory);
router.post('/outlet/inventory/transfer', authenticateJWT, transferStock);

module.exports = router;
