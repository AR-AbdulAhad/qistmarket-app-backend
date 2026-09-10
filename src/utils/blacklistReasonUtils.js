/**
 * Canonical blacklist reason types.
 *
 * `BlacklistAction.reason` is free text an officer types at blacklist time, so
 * the values that actually land in it are things like "checking", "again",
 * "jhgjhghgjhg" alongside genuine ones. Building the Blacklisted Customers
 * "Reason" filter from those distinct strings meant every typo became its own
 * permanent dropdown option, and the list grew without bound.
 *
 * So the filter is driven by this fixed vocabulary instead: each record is
 * classified into exactly one bucket, and the raw text is still shown in the
 * Reason column for detail. `BlacklistAction.category` (set by the manual
 * blacklist form) wins when present; otherwise the free text is keyword-matched
 * — officers write in both English and Roman Urdu, so both are covered.
 */

/**
 * `manual: false` means the bucket is never a legitimate choice for a person
 * filling in the blacklist form — `auto_delinquency` is the system's own and
 * `not_recorded` describes an absence. The dashboard renders only the manual
 * ones in its picker, so that distinction lives here rather than being
 * re-derived from a hard-coded code list on the frontend.
 */
const BLACKLIST_REASON_TYPES = [
    {
        code: 'auto_delinquency',
        label: 'Auto-flagged (90+ days overdue)',
        description: 'Flagged automatically by the 90-day delinquency rule, not by a person.',
        manual: false,
    },
    {
        code: 'non_payment',
        label: 'Non-payment / Defaulter',
        description: 'Stopped paying installments or refuses to clear arrears.',
        manual: true,
    },
    {
        code: 'fraud',
        label: 'Fraud / Fake documents',
        description: 'Forged CNIC, fake documents, impersonation or any deliberate deception.',
        manual: true,
    },
    {
        code: 'untraceable',
        label: 'Untraceable / Wrong contact',
        description: 'Address wrong, number off, shifted or absconded — cannot be reached.',
        manual: true,
    },
    {
        code: 'device_tampering',
        label: 'Device tampering / Resold',
        description: 'PayTrigger lock removed, IMEI changed, or the device was sold on.',
        manual: true,
    },
    {
        code: 'guarantor_issue',
        label: 'Guarantor issue',
        description: 'Blacklisted because of the guarantor — fake, uncooperative or defaulting.',
        manual: true,
    },
    {
        code: 'legal_action',
        label: 'Legal action / FIR',
        description: 'A police case, FIR or court proceeding is involved.',
        manual: true,
    },
    {
        code: 'other',
        label: 'Other (manual)',
        description: 'Manually blacklisted for a reason that does not fit the buckets above.',
        manual: true,
    },
    {
        code: 'not_recorded',
        label: 'History not recorded',
        description: 'Blacklisted before reason logging existed — no reason on file.',
        manual: false,
    },
];

const BLACKLIST_REASON_LABELS = BLACKLIST_REASON_TYPES.reduce((acc, t) => {
    acc[t.code] = t.label;
    return acc;
}, {});

// Codes a human may pick on the manual blacklist form.
const MANUAL_BLACKLIST_REASON_CODES = BLACKLIST_REASON_TYPES
    .filter((t) => t.manual)
    .map((t) => t.code);

// Legacy `category` values written before this vocabulary existed.
const LEGACY_CATEGORY_MAP = {
    auto: 'auto_delinquency',
    fraud: 'fraud',
    non_payment: 'non_payment',
    other: 'other',
};

/**
 * Keyword rules, most specific first. A reason like "phone bech kar qist band
 * kar di" mentions both a resale and non-payment; the resale is the more
 * actionable fact, so device/fraud rules are checked before non-payment.
 */
const KEYWORD_RULES = [
    { code: 'fraud', patterns: [/\bfraud/i, /\bfake\b/i, /\bforg(ed|ery)/i, /\bjaali\b/i, /\bjali\b/i, /\bfarzi\b/i, /\bbogus\b/i, /\bscam/i, /\bcheat/i, /\bdhoka\b/i, /\bdokha\b/i, /\bimpersonat/i, /\bfalse document/i] },
    { code: 'device_tampering', patterns: [/\bimei\b/i, /\btamper/i, /pay ?trigger/i, /\bunlock/i, /lock (remove|hata|khol)/i, /\bre-?sold\b/i, /\bsold the (phone|device|set)/i, /(phone|mobile|set) (bech|becha|bach)/i, /\bflash(ed)?\b/i, /\brooted?\b/i] },
    { code: 'legal_action', patterns: [/\bf\.?i\.?r\.?\b/i, /\bcourt\b/i, /\bpolice\b/i, /\blegal\b/i, /\blawyer\b/i, /\bmuqadma/i, /\bthana\b/i, /\bcase (file|darj)/i] },
    { code: 'untraceable', patterns: [/\buntraceable\b/i, /\bnot traceable\b/i, /\bunreachable\b/i, /\babscond/i, /\bfarar\b/i, /\bfrar\b/i, /\brefar\b/i, /\bshifted\b/i, /\bmakan (chor|khali)/i, /(ghar|makaan) chor/i, /(number|phone|mobile) (band|off|closed|bandh)/i, /\bwrong (number|address)\b/i, /\bghalat (number|address|pata)/i, /\bnot responding\b/i, /\bno contact\b/i, /\bmissing\b/i] },
    { code: 'guarantor_issue', patterns: [/\bguarantor/i, /\bgrantor/i, /\bzamin\b/i, /\bzaamin\b/i, /\bzimadar/i] },
    { code: 'non_payment', patterns: [/\bnon[- ]?payment\b/i, /\bdefault(er)?\b/i, /\bdelinquen/i, /\boverdue\b/i, /\barrears?\b/i, /\bnot pay(ing)?\b/i, /\bstopped paying\b/i, /\bqist\b/i, /\bkisht\b/i, /\binstall?ment/i, /\bpaisay?\b/i, /\bpayment (nahi|nhi|na)\b/i, /\bnadahindagi\b/i, /\brefus(e|ed|ing) to pay\b/i] },
];

/**
 * Maps one blacklist record onto the canonical vocabulary.
 *
 * @param {{ category?: string|null, reason?: string|null, isAuto?: boolean }} input
 * @returns {{ code: string, label: string }}
 */
function classifyBlacklistReason({ category, reason, isAuto = false } = {}) {
    const toResult = (code) => ({ code, label: BLACKLIST_REASON_LABELS[code] });

    if (isAuto) return toResult('auto_delinquency');

    const cat = (category || '').trim().toLowerCase();
    if (cat) {
        if (BLACKLIST_REASON_LABELS[cat]) return toResult(cat);
        if (LEGACY_CATEGORY_MAP[cat]) return toResult(LEGACY_CATEGORY_MAP[cat]);
    }

    const text = (reason || '').trim();
    if (!text) return toResult('not_recorded');

    for (const rule of KEYWORD_RULES) {
        if (rule.patterns.some((p) => p.test(text))) return toResult(rule.code);
    }

    // Real text that matched nothing — still a manual decision, so "other"
    // rather than "not recorded", which would misrepresent it as missing.
    return toResult('other');
}

module.exports = {
    BLACKLIST_REASON_TYPES,
    BLACKLIST_REASON_LABELS,
    MANUAL_BLACKLIST_REASON_CODES,
    classifyBlacklistReason,
};
