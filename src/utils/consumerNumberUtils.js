const prisma = require('../../lib/prisma');

const PREFIX = '1017100015';

/**
 * Generate a unique 1Bill/TPS consumer number.
 * 
 * Rules:
 * PRIORITY 1: IMEI/Serial. Use last 5 digits. If conflict, append '9'.
 * PRIORITY 2: Mobile. Use last 5 digits. If conflict, append '8'.
 */
async function generateConsumerNumber(imei, mobile) {
    let source = '';
    let conflictDigit = '';

    if (imei && typeof imei === 'string' && imei.replace(/\D/g, '').length >= 6) {
        source = imei.replace(/\D/g, '');
        conflictDigit = '0';
    } else if (mobile && typeof mobile === 'string') {
        source = mobile.replace(/\D/g, '');
        conflictDigit = '8';
    } else {
        // Ultimate fallback if neither is useful
        source = String(Date.now());
        conflictDigit = '0';
    }

    // Take the last 6 digits
    let suffix = source.slice(-6).padStart(6, '0');
    let candidate = PREFIX + suffix;

    // Check uniqueness in consumer_numbers table
    while (true) {
        const existing = await prisma.consumerNumber.findUnique({
            where: { consumer_number: candidate },
            select: { id: true }
        });

        if (!existing) break; // It is unique!

        // If exists, append the strict conflict digit (now suffix becomes 6 chars)
        candidate = candidate + conflictDigit;
    }

    return candidate;
}

const SMARTPAY_PREFIX = '6500';

/**
 * Generate a unique SmartPay consumer number.
 *
 * Must total 8 digits ("6500" + 4) to match the format SmartPay actually
 * accepts — confirmed against smartPayController.generateSmartPayQr's proven
 * live "6500" + 4-digit order id pattern. A previous 10-digit version
 * ("6500" + 6 digits) was rejected by SmartPay's DQR API on every call with
 * {"statusCode":"401","statusMessage":"Failed: 01-Invalid bill data)"}.
 *
 * On a suffix collision, the 4-digit suffix is incremented (wrapping mod
 * 10000) until a free one is found — never append extra digits on conflict,
 * that silently breaks the 8-digit requirement again (this is exactly how
 * every existing bad row in production got created, since IMEI/mobile
 * numbers frequently share the same last 4 digits across test/seed data).
 */
async function generateSmartPayConsumerNumber(imei, mobile) {
    const randomOffset = Math.floor(Math.random() * 9000) + 1000;
    const source = (
        (imei && typeof imei === 'string' && imei.replace(/\D/g, '').length >= 4)
            ? imei.replace(/\D/g, '')
            : (mobile && typeof mobile === 'string' ? mobile.replace(/\D/g, '') : String(Date.now()))
    );
    const baseSeed = parseInt(source.slice(-4).padStart(4, '0'), 10) || 1234;
    const seed = (baseSeed + randomOffset + Date.now()) % 10000;

    // Check uniqueness in consumer_numbers table
    for (let i = 0; i < 10000; i += 1) {
        const candidateSuffix = String((seed + i) % 10000).padStart(4, '0');
        const candidate = SMARTPAY_PREFIX + candidateSuffix;
        const existing = await prisma.consumerNumber.findUnique({
            where: { consumer_number: candidate },
            select: { id: true }
        });
        if (!existing) return candidate; // It is unique!
    }

    throw new Error(`generateSmartPayConsumerNumber: no free 8-digit number found for seed ${seed}`);
}

module.exports = { generateConsumerNumber, generateSmartPayConsumerNumber };
