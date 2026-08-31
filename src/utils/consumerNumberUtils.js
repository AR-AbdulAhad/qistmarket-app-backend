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
 * Rules:
 * PRIORITY 1: IMEI/Serial. Use last 4 digits. If conflict, append '9'.
 * PRIORITY 2: Mobile. Use last 4 digits. If conflict, append '8'.
 *
 * Must total 8 digits ("6500" + 4) to match the format SmartPay actually
 * accepts — confirmed against smartPayController.generateSmartPayQr's proven
 * live "6500" + 4-digit order id pattern. A previous 10-digit version
 * ("6500" + 6 digits) was rejected by SmartPay's DQR API on every call with
 * {"statusCode":"401","statusMessage":"Failed: 01-Invalid bill data)"}.
 */
async function generateSmartPayConsumerNumber(imei, mobile) {
    let source = '';
    let conflictDigit = '';

    if (imei && typeof imei === 'string' && imei.replace(/\D/g, '').length >= 4) {
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

    // Take the last 4 digits — matches SmartPay's accepted 8-digit total format.
    let suffix = source.slice(-4).padStart(4, '0');
    let candidate = SMARTPAY_PREFIX + suffix;

    // Check uniqueness in consumer_numbers table
    while (true) {
        const existing = await prisma.consumerNumber.findUnique({
            where: { consumer_number: candidate },
            select: { id: true }
        });

        if (!existing) break; // It is unique!

        // If exists, append the strict conflict digit
        candidate = candidate + conflictDigit;
    }

    return candidate;
}

module.exports = { generateConsumerNumber, generateSmartPayConsumerNumber };
