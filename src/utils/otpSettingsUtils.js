const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../config/otp_settings.json');

// In-memory cache to avoid disk reads on every OTP dispatch
let cachedSettings = null;

/**
 * Reads default settings from .env file
 */
const getDefaultSettings = () => {
  return {
    wati_enabled: process.env.WATI_OTP_ENABLED !== 'false',
    jazz_enabled: process.env.JAZZ_OTP_ENABLED === 'true',
  };
};

/**
 * Gets current OTP channel settings (reads from cache/file with .env fallback)
 */
const getOtpSettings = () => {
  if (cachedSettings) {
    return { ...cachedSettings };
  }

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(data);
      const defaults = getDefaultSettings();
      cachedSettings = {
        wati_enabled: typeof parsed.wati_enabled === 'boolean' ? parsed.wati_enabled : defaults.wati_enabled,
        jazz_enabled: typeof parsed.jazz_enabled === 'boolean' ? parsed.jazz_enabled : defaults.jazz_enabled,
      };
      return { ...cachedSettings };
    }
  } catch (err) {
    console.error('[OTP Settings] Error reading config file:', err?.message || err);
  }

  cachedSettings = getDefaultSettings();
  return { ...cachedSettings };
};

/**
 * Saves updated OTP channel settings to file and updates cache
 */
const saveOtpSettings = (newSettings) => {
  try {
    const current = getOtpSettings();
    const updated = {
      wati_enabled: typeof newSettings.wati_enabled === 'boolean' ? newSettings.wati_enabled : current.wati_enabled,
      jazz_enabled: typeof newSettings.jazz_enabled === 'boolean' ? newSettings.jazz_enabled : current.jazz_enabled,
    };

    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf8');
    cachedSettings = updated;
    console.log('[OTP Settings] Updated settings:', updated);
    return { success: true, settings: updated };
  } catch (err) {
    console.error('[OTP Settings] Error saving config file:', err?.message || err);
    return { success: false, error: err?.message || String(err) };
  }
};

module.exports = {
  getOtpSettings,
  saveOtpSettings,
};
