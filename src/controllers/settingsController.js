const { getOutletSettings, saveOutletSettings } = require('../utils/settingsUtils');

const getAutoAssignmentSettings = async (req, res) => {
    const outletId = req.user.outlet_id;
    if (!outletId) {
        return res.status(403).json({ success: false, message: 'Outlet ID not found in user session' });
    }

    const settings = await getOutletSettings(outletId);
    res.json({ success: true, settings });
};

const updateAutoAssignmentSettings = async (req, res) => {
    const outletId = req.user.outlet_id;
    const { settings } = req.body;

    if (!outletId) {
        return res.status(403).json({ success: false, message: 'Outlet ID not found in user session' });
    }

    if (!settings) {
        return res.status(400).json({ success: false, message: 'Settings are required' });
    }

    const success = await saveOutletSettings(outletId, settings);
    if (success) {
        res.json({ success: true, message: 'Settings updated successfully' });
    } else {
        res.status(500).json({ success: false, message: 'Failed to save settings' });
    }
};

module.exports = {
    getAutoAssignmentSettings,
    updateAutoAssignmentSettings
};
