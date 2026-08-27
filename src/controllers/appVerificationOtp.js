require('dotenv').config();

const prisma = require('../../lib/prisma');
const { sendOtp, sendGuarantorOtp } = require('../services/otpDispatcher');

const fmt = (n) => Math.round(Number(n) || 0);

// Builds the order/officer context the full Jazz SMS templates need
// (Guarantor OTP Confirmation / Purchaser Verification OTP). Optional —
// callers that don't send `order_id` still get the short OTP SMS via
// otpDispatcher's context-less fallback. Never throws: a lookup failure
// just means the short SMS gets sent instead of the detailed one.
const buildOtpContext = async (orderId, phone, isGuarantor, typedName) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        outlet: { select: { name: true } },
        verification: {
          include: {
            grantors: true,
            verification_officer: { select: { full_name: true, phone: true } },
          },
        },
      },
    });
    if (!order) return null;

    const base = {
      customerName: order.customer_name,
      orderNumber: order.order_ref,
      itemNameModel: order.product_name,
      totalInstallmentPrice: fmt(order.total_amount),
      advanceAmount: fmt(order.advance_amount),
      installmentDuration: order.months,
      monthlyInstallment: fmt(order.monthly_amount),
    };

    if (isGuarantor) {
      // At this point in the flow the guarantor's form hasn't been submitted/
      // saved yet, so there's usually no GrantorVerification row to match by
      // phone — fall back to the name the officer just typed in the app
      // rather than the generic "Guarantor" placeholder.
      const grantor = order.verification?.grantors?.find((g) => g.telephone_number === phone);
      return {
        ...base,
        guarantorName: grantor?.name || typedName || 'Guarantor',
        price: base.totalInstallmentPrice,
      };
    }

    return {
      ...base,
      outletName: order.outlet?.name || 'N/A',
      verificationOfficerName: order.verification?.verification_officer?.full_name,
      verificationOfficerNumber: order.verification?.verification_officer?.phone,
    };
  } catch (err) {
    console.error('[sendCode] buildOtpContext failed:', err.message);
    return null;
  }
};

// Guarantor OTP Confirmation (name present) and Purchaser Verification OTP
// (name absent) both route through otpDispatcher.js, so a single pair of
// .env flags — WATI_OTP_ENABLED / JAZZ_OTP_ENABLED — controls both the
// WhatsApp (WATI) and SMS (Jazz) channels for both flows. Passing `order_id`
// additionally upgrades the Jazz SMS from a short generic OTP to the full,
// order-detail-rich template — see buildOtpContext above.
const sendCode = async (req, res) => {
  const { code, phone, name, order_id } = req.body;

  if (!/^\d{5}$/.test(code)) {
    return res.status(400).json({
      success: false,
      error: 'Code must be a 5-digit number.'
    });
  }

  if (!/^03\d{9}$/.test(phone)) {
    return res.status(400).json({
      success: false,
      error: 'Phone must be an 11-digit Pakistani number starting with 03.'
    });
  }

  try {
    console.log(`[OTP] ${name ? `Guarantor (${name})` : 'Purchaser'} — phone=${phone} order_id=${order_id || 'n/a'} code=${code}`);

    const context = order_id ? await buildOtpContext(parseInt(order_id), phone, Boolean(name), name) : null;

    const result = name
      ? await sendGuarantorOtp(phone, name, code, context)
      : await sendOtp(phone, code, context);

    if (!result.success) {
      return res.status(502).json({
        success: false,
        error: 'Failed to send code. Please try again later.'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Code sent successfully.',
    });
  } catch (error) {
    console.error('sendCode error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to send code. Please try again later.'
    });
  }
};

module.exports = { sendCode };
