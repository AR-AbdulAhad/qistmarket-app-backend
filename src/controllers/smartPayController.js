const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const qrcode = require('qrcode');

const SMARTPAY_TOKEN_URL = 'https://smartpay.com.pk/services/api/v1/token';
const SMARTPAY_DQR_URL = 'https://smartpay.com.pk/services/api/v1/DQR';

const generateSmartPayQr = async (req, res) => {
    const { order_id, month_number, amount, force_regenerate } = req.body;
    const { outlet_id, role } = req.user || {};

    const isOutletUser = !!outlet_id;
    const isRecoveryOfficer = role?.toLowerCase()?.includes('recovery officer');

    if (!isOutletUser && !isRecoveryOfficer) {
        return res.status(403).json({ success: false, message: 'Not authorized. Only outlet users and recovery officers can access this.' });
    }

    if (!order_id || month_number === undefined || !amount) {
        return res.status(400).json({ success: false, message: 'Missing required parameters' });
    }

    try {
        // 1. Check if we already generated a QR for this installment
        if (!force_regenerate) {
            const existingQr = await prisma.smartPayQr.findUnique({
                where: {
                    order_id_month_number: {
                        order_id: parseInt(order_id),
                        month_number: parseInt(month_number),
                    }
                }
            });

            if (existingQr) {
                return res.json({
                    success: true,
                    data: {
                        qr_string: existingQr.qr_string,
                        qr_image_base64: existingQr.qr_image_base64,
                        amount: existingQr.amount
                    }
                });
            }
        }

        // 2. Fetch Order and Customer details
        const order = await prisma.order.findUnique({
            where: { id: parseInt(order_id) },
            include: {
                verification: { include: { purchaser: true } }
            }
        });

        if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

        const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
        const name = order.verification?.purchaser?.name || order.customer_name;

        let consumerNumber = "6002" + order.id.toString().padStart(4, '0');

        // Formulate Billing Month in YYMM format (current month)
        const date = new Date();
        const yy = String(date.getFullYear()).slice(-2);
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const billingMonth = `${yy}${mm}`;

        const refInfo = `QIST-${order.id}-${month_number}-${Date.now()}`.substring(0, 30);

        // 3. Call SmartPay Token API
        const username = process.env.SMARTPAY_USERNAME || 'test';
        const password = process.env.SMARTPAY_PASSWORD || 'test';

        let tokenResponse;
        try {
            const tokenReq = await fetch(SMARTPAY_TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const textResp = await tokenReq.text();
            try {
                tokenResponse = JSON.parse(textResp);
            } catch (err) {
                console.error('SmartPay Token Error - Not JSON. Response:', textResp);
                return res.status(500).json({ success: false, message: 'Payment gateway returned invalid token response' });
            }
        } catch (e) {
            console.error('SmartPay Token Fetch Error:', e);
            return res.status(500).json({ success: false, message: 'Failed to authenticate with Payment Gateway' });
        }

        if (tokenResponse?.statusCode !== "200" || !tokenResponse?.dist?.jwtToken) {
            return res.status(500).json({ success: false, message: 'Payment Gateway Authentication Failed' });
        }

        const jwtToken = tokenResponse.dist.jwtToken;

        // 4. Call SmartPay DQR API
        const payload = {
            Consumer_Number: consumerNumber,
            Consumer_Detail: name,
            Billing_Month: billingMonth,
            Amount: parseFloat(amount).toFixed(2),
            CellNo: phone,
            EMail: "",
            ReferenceInfo: refInfo,
            reserved: ""
        };

        let dqrResponse;
        try {
            const dqrReq = await fetch(SMARTPAY_DQR_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `${jwtToken}`
                },
                body: JSON.stringify(payload)
            });
            const textResp = await dqrReq.text();
            try {
                dqrResponse = JSON.parse(textResp);
            } catch (err) {
                console.error('SmartPay DQR Error - Not JSON. Response:', textResp);
                return res.status(500).json({ success: false, message: 'Payment gateway returned invalid DQR response' });
            }
        } catch (e) {
            console.error('SmartPay DQR Fetch Error:', e);
            return res.status(500).json({ success: false, message: 'Failed to generate QR string from Gateway' });
        }

        if (dqrResponse?.statusCode !== "200" || !dqrResponse?.QrString) {
            return res.status(500).json({ success: false, message: 'Gateway refused to map the QR payload' });
        }

        const qrString = dqrResponse.QrString;

        // 5. Generate base64 image from QrString
        let qrImageBase64 = "";
        try {
            qrImageBase64 = await qrcode.toDataURL(qrString, {
                errorCorrectionLevel: 'H',
                margin: 2,
                width: 400
            });
        } catch (e) {
            console.error('QRCode conversion error:', e);
            return res.status(500).json({ success: false, message: 'Failed to render QR Code image' });
        }

        // 6. Save in database
        const savedQr = await prisma.smartPayQr.upsert({
            where: {
                order_id_month_number: {
                    order_id: parseInt(order_id),
                    month_number: parseInt(month_number)
                }
            },
            update: {
                qr_string: qrString,
                qr_image_base64: qrImageBase64,
                amount: parseFloat(amount)
            },
            create: {
                order_id: parseInt(order_id),
                month_number: parseInt(month_number),
                qr_string: qrString,
                qr_image_base64: qrImageBase64,
                amount: parseFloat(amount)
            }
        });

        return res.json({
            success: true,
            data: {
                qr_string: savedQr.qr_string,
                qr_image_base64: savedQr.qr_image_base64,
                amount: savedQr.amount
            }
        });

    } catch (error) {
        console.error('generateSmartPayQr error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error while generating QR code' });
    }
};

const checkSmartPayQr = async (req, res) => {
    const { order_id, month_number } = req.query;
    const { outlet_id, role } = req.user || {};

    // Allow outlet users and recovery officers only
    const isOutletUser = !!outlet_id;
    const isRecoveryOfficer = role?.toLowerCase()?.includes('recovery officer');

    if (!isOutletUser && !isRecoveryOfficer) {
        return res.status(403).json({ success: false, message: 'Not authorized. Only outlet users and recovery officers can access this.' });
    }

    if (!order_id || month_number === undefined) {
        return res.status(400).json({ success: false, message: 'Missing required parameters' });
    }

    try {
        const existingQr = await prisma.smartPayQr.findUnique({
            where: {
                order_id_month_number: {
                    order_id: parseInt(order_id),
                    month_number: parseInt(month_number),
                }
            }
        });

        if (existingQr) {
            return res.json({
                success: true,
                data: {
                    qr_string: existingQr.qr_string,
                    qr_image_base64: existingQr.qr_image_base64,
                    amount: existingQr.amount
                }
            });
        }

        return res.json({ success: true, data: null });
    } catch (error) {
        console.error('checkSmartPayQr error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error while checking QR' });
    }
};

module.exports = {
    generateSmartPayQr,
    checkSmartPayQr
};
