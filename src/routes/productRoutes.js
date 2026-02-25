const express = require('express');
const router = express.Router();
const { getProducts } = require('../controllers/productController');
const { authenticateJWT } = require('../middlewares/authMiddleware');

// Public or Authenticated? 
// The user said "backend me is api ke product ko fetch karo or ftech karne ke apna api bnao"
// Usually the dashboard requires auth.
router.get('/products', authenticateJWT, getProducts);

module.exports = router;
