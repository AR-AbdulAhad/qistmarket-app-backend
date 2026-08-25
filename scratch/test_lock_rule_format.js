require('dotenv').config();
const pt = require('../src/services/paytriggerService');

async function testLockRuleFormats() {
  const whitelistArray = [
    { appName: 'Phone', packageName: 'com.google.android.dialer' },
    { appName: 'Phone', packageName: 'com.android.dialer' },
    { appName: 'Gmail', packageName: 'com.google.android.gm' },
    { appName: 'easypaisa', packageName: 'com.telcom.easypaisa' },
    { appName: 'JazzCash', packageName: 'com.techlogix.mobilinkcustomer' }
  ];

  // Try format 1: whitelistAppContent as JSON string
  try {
    console.log('Testing Format 1...');
    const res1 = await pt.updateCompanyLockRule({
      whitelistAppContent: JSON.stringify(whitelistArray)
    });
    console.log('Res 1:', res1);
  } catch (e) {
    console.log('Err 1:', e.message);
  }

  // Try format 2: setLockRule for device / rule
  try {
    console.log('Testing queryLockState / companyConfig...');
    const configRes = await pt.queryCompanyConfig();
    console.log('Current Whitelist App Content:', configRes?.data?.whitelistAppContent);
    console.log('Current Screen Blocked Content:', configRes?.data?.screenBlockedContent);
    console.log('Current App Blocked Content:', configRes?.data?.appBlockedContent);
  } catch (e) {
    console.log('Err 2:', e.message);
  }
}

testLockRuleFormats();
