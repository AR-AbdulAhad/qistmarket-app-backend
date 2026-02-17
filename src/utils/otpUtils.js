const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Generate 5-digit OTP
const generateOTP = () => {
  return crypto.randomInt(10000, 99999).toString();
};

// Save OTP to database with proper expiration
const saveOTP = async (phone, purpose = 'login') => {
  try {
    // Delete old unused OTPs for this phone
    await prisma.otp.deleteMany({
      where: {
        phone,
        isUsed: false,
        expiresAt: { lt: new Date() }
      }
    });

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.otp.create({
      data: {
        phone,
        otp,
        purpose,
        expiresAt
      }
    });

    return otp;
  } catch (error) {
    console.error('Error saving OTP:', error);
    throw new Error('Failed to generate OTP');
  }
};

// Verify OTP
const verifyOTP = async (phone, otp, purpose = 'login') => {
  try {
    const otpRecord = await prisma.otp.findFirst({
      where: {
        phone,
        otp,
        purpose,
        isUsed: false,
        expiresAt: { gt: new Date() }
      }
    });

    if (!otpRecord) {
      return { valid: false, message: 'Invalid or expired OTP' };
    }

    // Mark OTP as used
    await prisma.otp.update({
      where: { id: otpRecord.id },
      data: { isUsed: true }
    });

    return { valid: true, message: 'OTP verified successfully' };
  } catch (error) {
    console.error('Error verifying OTP:', error);
    return { valid: false, message: 'Error verifying OTP' };
  }
};

// Clean up expired OTPs (call this periodically)
const cleanupExpiredOTPs = async () => {
  try {
    const result = await prisma.otp.deleteMany({
      where: {
        expiresAt: { lt: new Date() }
      }
    });
    console.log(`Cleaned up ${result.count} expired OTPs`);
  } catch (error) {
    console.error('Error cleaning up OTPs:', error);
  }
};

module.exports = { generateOTP, saveOTP, verifyOTP, cleanupExpiredOTPs };