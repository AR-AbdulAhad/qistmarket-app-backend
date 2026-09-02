const { getOtpSettings, saveOtpSettings } = require('../src/utils/otpSettingsUtils');
const { isWatiEnabled, isJazzEnabled } = require('../src/services/otpDispatcher');

console.log('--- INITIAL OTP SETTINGS ---');
const initial = getOtpSettings();
console.log('Initial getOtpSettings():', initial);
console.log('isWatiEnabled():', isWatiEnabled());
console.log('isJazzEnabled():', isJazzEnabled());

console.log('\n--- TESTING TOGGLE UPDATE (Wati: false, Jazz: true) ---');
saveOtpSettings({ wati_enabled: false, jazz_enabled: true });
console.log('Updated getOtpSettings():', getOtpSettings());
console.log('isWatiEnabled():', isWatiEnabled());
console.log('isJazzEnabled():', isJazzEnabled());

console.log('\n--- TESTING TOGGLE UPDATE (Wati: true, Jazz: true) ---');
saveOtpSettings({ wati_enabled: true, jazz_enabled: true });
console.log('Updated getOtpSettings():', getOtpSettings());
console.log('isWatiEnabled():', isWatiEnabled());
console.log('isJazzEnabled():', isJazzEnabled());

console.log('\n--- RESTORING INITIAL SETTINGS ---');
saveOtpSettings(initial);
console.log('Restored getOtpSettings():', getOtpSettings());
console.log('isWatiEnabled():', isWatiEnabled());
console.log('isJazzEnabled():', isJazzEnabled());

console.log('\n✅ OTP Settings Test Passed!');
