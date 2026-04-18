const express = require('express');
const router = express.Router();
const { globalSearch } = require('../controllers/searchController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

router.get('/outlet/search', authenticateJWT, globalSearch);

module.exports = router;
