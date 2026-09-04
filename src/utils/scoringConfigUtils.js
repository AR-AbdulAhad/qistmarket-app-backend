const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../config/scoring_rules.json');

let cachedConfig = null;

const DEFAULT_SCORING_CONFIG = {
  outlet: {
    points_per_delivered_order: 10,
    points_deducted_per_returned_order: 10,
    sales_divisor: 1000,
    sales_multiplier: 1,
    recovery_pct_multiplier: 5,
  },
  csr: {
    points_per_delivered_order: 10,
    points_deducted_per_returned_order: 5,
    points_deducted_per_cancelled_order: 1,
    points_deducted_per_expired_order: 3,
    points_per_completed_order: 5,
    points_per_repeat_customer: 5,
    points_per_solved_complaint: 1,
  },
  delivery: {
    points_per_delivered_order: 15,
    points_deducted_per_returned_order: 5,
    points_deducted_per_cancelled_order: 2,
    points_deducted_per_expired_order: 3,
    points_per_completed_order: 5,
  },
  recovery: {
    points_per_collected_visit: 15,
    points_deducted_per_returned_order: 5,
    points_deducted_per_cancelled_order: 2,
    points_deducted_per_expired_order: 3,
    points_per_completed_order: 5,
  },
  verification: {
    points_per_completed_verification: 10,
    points_per_delivered_order: 5,
    points_deducted_per_returned_order: 5,
    points_deducted_per_cancelled_order: 2,
    points_deducted_per_expired_order: 3,
  },
};

function getScoringConfig() {
  if (cachedConfig) return JSON.parse(JSON.stringify(cachedConfig));

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(data);
      cachedConfig = {
        outlet: { ...DEFAULT_SCORING_CONFIG.outlet, ...(parsed.outlet || {}) },
        csr: { ...DEFAULT_SCORING_CONFIG.csr, ...(parsed.csr || {}) },
        delivery: { ...DEFAULT_SCORING_CONFIG.delivery, ...(parsed.delivery || {}) },
        recovery: { ...DEFAULT_SCORING_CONFIG.recovery, ...(parsed.recovery || {}) },
        verification: { ...DEFAULT_SCORING_CONFIG.verification, ...(parsed.verification || {}) },
      };
      return JSON.parse(JSON.stringify(cachedConfig));
    }
  } catch (e) {
    console.error('[ScoringConfig] Error reading config file:', e.message);
  }

  cachedConfig = DEFAULT_SCORING_CONFIG;
  return JSON.parse(JSON.stringify(cachedConfig));
}

function saveScoringConfig(newConfig) {
  try {
    const current = getScoringConfig();
    const updated = {
      outlet: { ...current.outlet, ...(newConfig.outlet || {}) },
      csr: { ...current.csr, ...(newConfig.csr || {}) },
      delivery: { ...current.delivery, ...(newConfig.delivery || {}) },
      recovery: { ...current.recovery, ...(newConfig.recovery || {}) },
      verification: { ...current.verification, ...(newConfig.verification || {}) },
    };

    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf8');
    cachedConfig = updated;
    console.log('[ScoringConfig] Scoring rules saved successfully.');
    return { success: true, config: updated };
  } catch (e) {
    console.error('[ScoringConfig] Error saving config file:', e.message);
    return { success: false, error: e.message };
  }
}

module.exports = {
  getScoringConfig,
  saveScoringConfig,
  DEFAULT_SCORING_CONFIG,
};
