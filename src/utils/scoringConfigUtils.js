const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../config/scoring_rules.json');
const OVERRIDES_PATH = path.join(__dirname, '../config/scoring_overrides.json');

let cachedConfig = null;
let cachedOverrides = null;

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

function getOverridesConfig() {
  if (cachedOverrides) return JSON.parse(JSON.stringify(cachedOverrides));

  try {
    if (fs.existsSync(OVERRIDES_PATH)) {
      const data = fs.readFileSync(OVERRIDES_PATH, 'utf8');
      const parsed = JSON.parse(data);
      cachedOverrides = {
        outlets: parsed.outlets || {},
        officers: parsed.officers || {},
      };
      return JSON.parse(JSON.stringify(cachedOverrides));
    }
  } catch (e) {
    console.error('[ScoringConfig] Error reading overrides file:', e.message);
  }

  cachedOverrides = { outlets: {}, officers: {} };
  return JSON.parse(JSON.stringify(cachedOverrides));
}

function saveOverride(type, id, section, rules) {
  try {
    const currentOverrides = getOverridesConfig();
    const targetGroup = type === 'outlet' ? 'outlets' : 'officers';
    const key = String(id);

    if (!currentOverrides[targetGroup]) {
      currentOverrides[targetGroup] = {};
    }

    if (!rules || Object.keys(rules).length === 0) {
      if (currentOverrides[targetGroup][key]) {
        delete currentOverrides[targetGroup][key][section];
        if (Object.keys(currentOverrides[targetGroup][key]).length === 0) {
          delete currentOverrides[targetGroup][key];
        }
      }
    } else {
      if (!currentOverrides[targetGroup][key]) {
        currentOverrides[targetGroup][key] = {};
      }
      currentOverrides[targetGroup][key][section] = {
        ...(currentOverrides[targetGroup][key][section] || {}),
        ...rules,
      };
    }

    const dir = path.dirname(OVERRIDES_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(currentOverrides, null, 2), 'utf8');
    cachedOverrides = currentOverrides;
    console.log(`[ScoringConfig] Saved override for ${targetGroup}:${key}:${section}`);
    return { success: true, overrides: currentOverrides };
  } catch (e) {
    console.error('[ScoringConfig] Error saving override:', e.message);
    return { success: false, error: e.message };
  }
}

function deleteOverride(type, id, section) {
  try {
    const currentOverrides = getOverridesConfig();
    const targetGroup = type === 'outlet' ? 'outlets' : 'officers';
    const key = String(id);

    if (currentOverrides[targetGroup] && currentOverrides[targetGroup][key]) {
      if (section) {
        delete currentOverrides[targetGroup][key][section];
        if (Object.keys(currentOverrides[targetGroup][key]).length === 0) {
          delete currentOverrides[targetGroup][key];
        }
      } else {
        delete currentOverrides[targetGroup][key];
      }
    }

    const dir = path.dirname(OVERRIDES_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(currentOverrides, null, 2), 'utf8');
    cachedOverrides = currentOverrides;
    return { success: true, overrides: currentOverrides };
  } catch (e) {
    console.error('[ScoringConfig] Error deleting override:', e.message);
    return { success: false, error: e.message };
  }
}

function getEffectiveScoringRules(section, entityType = null, entityId = null) {
  const globalConfig = getScoringConfig();
  const globalRules = globalConfig[section] || {};

  if (!entityType || !entityId) {
    return globalRules;
  }

  const overrides = getOverridesConfig();
  const group = entityType === 'outlet' ? 'outlets' : 'officers';
  const entityOverrides = overrides[group]?.[String(entityId)]?.[section];

  if (!entityOverrides) {
    return globalRules;
  }

  return {
    ...globalRules,
    ...entityOverrides,
  };
}

module.exports = {
  getScoringConfig,
  saveScoringConfig,
  getOverridesConfig,
  saveOverride,
  deleteOverride,
  getEffectiveScoringRules,
  DEFAULT_SCORING_CONFIG,
};
