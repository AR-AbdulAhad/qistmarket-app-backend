const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../config/payment_instructions_settings.json');

// In-memory cache to avoid disk reads on every ledger page render
let cachedSettings = null;

const getDefaultSettings = () => ({
  payment_instructions_url: '',
});

/**
 * Gets the current "Payment Karne ka Tareeqa" link (reads from cache/file)
 */
const getPaymentInstructionsSettings = () => {
  if (cachedSettings) {
    return { ...cachedSettings };
  }

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(data);
      cachedSettings = {
        payment_instructions_url: typeof parsed.payment_instructions_url === 'string' ? parsed.payment_instructions_url : '',
      };
      return { ...cachedSettings };
    }
  } catch (err) {
    console.error('[Payment Instructions Settings] Error reading config file:', err?.message || err);
  }

  cachedSettings = getDefaultSettings();
  return { ...cachedSettings };
};

/**
 * Saves the updated payment instructions link to file and updates cache
 */
const savePaymentInstructionsSettings = (newSettings) => {
  try {
    const current = getPaymentInstructionsSettings();
    const updated = {
      payment_instructions_url: typeof newSettings.payment_instructions_url === 'string'
        ? newSettings.payment_instructions_url.trim()
        : current.payment_instructions_url,
    };

    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf8');
    cachedSettings = updated;
    console.log('[Payment Instructions Settings] Updated settings:', updated);
    return { success: true, settings: updated };
  } catch (err) {
    console.error('[Payment Instructions Settings] Error saving config file:', err?.message || err);
    return { success: false, error: err?.message || String(err) };
  }
};

module.exports = {
  getPaymentInstructionsSettings,
  savePaymentInstructionsSettings,
};
