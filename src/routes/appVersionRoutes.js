const express = require('express');
const router = express.Router();
const { getLatestVersion, updateAppVersion } = require('../controllers/appVersionController');

router.get('/latest', getLatestVersion);

router.put('/update', updateAppVersion);

module.exports = router;