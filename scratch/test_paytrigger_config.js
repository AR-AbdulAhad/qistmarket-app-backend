require('dotenv').config();
const pt = require('../src/services/paytriggerService');

async function testConfig() {
  try {
    console.log('Querying PayTrigger Company Config...');
    const res = await pt.queryCompanyConfig();
    console.log('Result:', JSON.stringify(res, null, 2));
  } catch (err) {
    console.error('Error:', err.message || err);
  }
}

testConfig();
