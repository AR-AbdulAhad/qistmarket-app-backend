require('dotenv').config();
const pt = require('../src/services/paytriggerService');

async function testUpdateWhitelist() {
  try {
    console.log('Testing PayTrigger whitelistAppContent update...');
    
    // Define Whitelisted Apps: Only Dialer (Phone), Gmail, and Banking Apps
    const whitelistApps = [
      { appName: 'Phone', packageName: 'com.google.android.dialer' },
      { appName: 'Phone', packageName: 'com.android.dialer' },
      { appName: 'Phone', packageName: 'com.transsion.dialer' },
      { appName: 'Gmail', packageName: 'com.google.android.gm' },
      { appName: 'easypaisa', packageName: 'com.telcom.easypaisa' },
      { appName: 'JazzCash', packageName: 'com.techlogix.mobilinkcustomer' },
      { appName: 'HBL Mobile', packageName: 'com.hbl.mobilebanking' },
      { appName: 'Meezan Mobile', packageName: 'com.mbl.com.mbl.meezanmobileapp' },
    ];

    const ruleData = {
      ruleNum: 0,
      whitelistAppContent: JSON.stringify(whitelistApps)
    };

    console.log('Sending ruleData:', ruleData);
    const res = await pt.updateCompanyLockRule(ruleData);
    console.log('Result:', JSON.stringify(res, null, 2));

    // Query config again to verify
    const newConfig = await pt.queryCompanyConfig();
    console.log('New Config:', JSON.stringify(newConfig, null, 2));
  } catch (err) {
    console.error('Error:', err.message || err);
  }
}

testUpdateWhitelist();
