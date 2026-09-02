const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { getOutletSettings, saveOutletSettings } = require('../utils/settingsUtils');
const { getOtpSettings, saveOtpSettings } = require('../utils/otpSettingsUtils');

// Helper: resolve outlet_id from JWT or from DB (for users logged in via main auth)
const resolveOutletId = async (req) => {
    if (req.user?.outlet_id) return req.user.outlet_id;

    // Fall back: look up the user's outlet_id from the database
    if (req.user?.id) {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: { outlet_id: true }
        });
        return user?.outlet_id || null;
    }
    return null;
};

const getAutoAssignmentSettings = async (req, res) => {
    try {
        const outletId = await resolveOutletId(req);
        if (!outletId) {
            return res.status(403).json({ success: false, message: 'Outlet ID not found. Please login as an outlet user.' });
        }

        const settings = await getOutletSettings(outletId);
        res.json({ success: true, settings });
    } catch (error) {
        console.error('getAutoAssignmentSettings error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const updateAutoAssignmentSettings = async (req, res) => {
    const { settings } = req.body;

    if (!settings) {
        return res.status(400).json({ success: false, message: 'Settings are required' });
    }

    try {
        const outletId = await resolveOutletId(req);
        if (!outletId) {
            return res.status(403).json({ success: false, message: 'Outlet ID not found. Please login as an outlet user.' });
        }

        const success = await saveOutletSettings(outletId, settings);
        if (success) {
            res.json({ success: true, message: 'Settings updated successfully' });
        } else {
            res.status(500).json({ success: false, message: 'Failed to save settings' });
        }
    } catch (error) {
        console.error('updateAutoAssignmentSettings error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getOtpChannelSettings = async (req, res) => {
    try {
        const settings = getOtpSettings();
        return res.json({ success: true, settings });
    } catch (error) {
        console.error('getOtpChannelSettings error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const updateOtpChannelSettings = async (req, res) => {
    try {
        const { wati_enabled, jazz_enabled } = req.body;
        if (typeof wati_enabled !== 'boolean' && typeof jazz_enabled !== 'boolean') {
            return res.status(400).json({ success: false, message: 'At least one channel setting (wati_enabled or jazz_enabled) must be provided as a boolean.' });
        }

        const result = saveOtpSettings({ wati_enabled, jazz_enabled });
        if (!result.success) {
            return res.status(500).json({ success: false, message: result.error || 'Failed to save OTP settings' });
        }

        return res.json({ success: true, message: 'OTP channel settings updated successfully', settings: result.settings });
    } catch (error) {
        console.error('updateOtpChannelSettings error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    getAutoAssignmentSettings,
    updateAutoAssignmentSettings,
    getOtpChannelSettings,
    updateOtpChannelSettings,
};

