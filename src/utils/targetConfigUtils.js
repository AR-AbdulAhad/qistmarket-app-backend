const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../config/csr_targets.json');

let cachedConfig = null;

// Same fallback values getCsrDashboardStats previously read straight from
// process.env.CSR_MONTHLY_TARGET / CSR_CUSTOMER_TARGET, kept here so an
// unconfigured install behaves exactly as before.
const DEFAULT_TARGET_CONFIG = {
  csr_monthly_sales_target: Number(process.env.CSR_MONTHLY_TARGET || process.env.CSR_SALES_TARGET || 1286500),
  csr_customer_target: Number(process.env.CSR_CUSTOMER_TARGET || 486),
};

function getTargetConfig() {
  if (cachedConfig) return { ...cachedConfig };

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(data);
      cachedConfig = { ...DEFAULT_TARGET_CONFIG, ...parsed };
      return { ...cachedConfig };
    }
  } catch (e) {
    console.error('[TargetConfig] Error reading config file:', e.message);
  }

  cachedConfig = DEFAULT_TARGET_CONFIG;
  return { ...cachedConfig };
}

function saveTargetConfig(newConfig) {
  try {
    const current = getTargetConfig();
    const updated = {
      csr_monthly_sales_target: Number(newConfig.csr_monthly_sales_target ?? current.csr_monthly_sales_target),
      csr_customer_target: Number(newConfig.csr_customer_target ?? current.csr_customer_target),
    };

    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf8');
    cachedConfig = updated;
    console.log('[TargetConfig] CSR targets saved successfully.');
    return { success: true, config: updated };
  } catch (e) {
    console.error('[TargetConfig] Error saving config file:', e.message);
    return { success: false, error: e.message };
  }
}

module.exports = {
  getTargetConfig,
  saveTargetConfig,
  DEFAULT_TARGET_CONFIG,
};
