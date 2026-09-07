// A legacy-imported order (channel = 'legacy_import') stays hidden from every
// general order/customer browsing list until an admin fills in the missing
// media/location and marks it complete on the Pending Legacy Profiles screen
// (see legacyImportController.js markComplete, which clears both flags).
const EXCLUDE_PENDING_LEGACY_IMPORT = {
  NOT: {
    channel: 'legacy_import',
    OR: [{ needs_media_upload: true }, { needs_location: true }],
  },
};

// Callers that let the caller explicitly filter by channel (e.g. an admin
// tool intentionally browsing legacy_import orders) should skip the
// exclusion rather than fight the caller's own request.
const isRequestingLegacyImportChannel = (channelFilterValue) => {
  if (!channelFilterValue) return false;
  return String(channelFilterValue)
    .split(',')
    .map((s) => s.trim())
    .includes('legacy_import');
};

module.exports = { EXCLUDE_PENDING_LEGACY_IMPORT, isRequestingLegacyImportChannel };
