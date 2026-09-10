// Notifications disabled by request. Keep the scheduler entry point without
// sending messages or changing ledger notification timestamps.
const runInstallmentReminders = async () => ({
  sentCount: 0,
  failedCount: 0,
  skipped: true,
  reason: 'notification_disabled',
});

module.exports = { runInstallmentReminders };
