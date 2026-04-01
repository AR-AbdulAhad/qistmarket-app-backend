const getOTPEmailTemplate = (otp, type = 'login', userName = 'User') => {
    const isWebLogin = type === 'web_login';
    const title = isWebLogin ? 'Dashboard Verification' : 'Login Verification';
    const currentYear = new Date().getFullYear();

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background-color: #ffffff;
            margin: 0;
            padding: 0;
            color: #111827;
        }
        .wrapper {
            width: 100%;
            table-layout: fixed;
            background-color: #ffffff;
            padding-bottom: 40px;
        }
        .container {
            max-width: 500px;
            margin: 0 auto;
            padding: 40px 20px;
        }
        .header {
            text-align: left;
            margin-bottom: 40px;
        }
        .logo {
            font-size: 20px;
            font-weight: 700;
            letter-spacing: -0.5px;
        }
        .content {
            text-align: left;
        }
        .content h1 {
            font-size: 28px;
            font-weight: 600;
            letter-spacing: -0.5px;
            margin-bottom: 24px;
            color: #111827;
        }
        .content p {
            font-size: 16px;
            line-height: 1.5;
            color: #4B5563;
            margin-bottom: 32px;
        }
        .otp-box {
            background-color: #F3F4F6;
            border-radius: 12px;
            padding: 24px;
            text-align: center;
            margin-bottom: 32px;
        }
        .otp-code {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 40px;
            font-weight: 700;
            letter-spacing: 12px;
            color: #111827;
            margin: 0;
            padding-left: 12px; /* balance the letter-spacing */
        }
        .footer {
            margin-top: 60px;
            padding-top: 24px;
            border-top: 1px solid #E5E7EB;
            font-size: 13px;
            color: #9CA3AF;
        }
        .footer p {
            margin: 4px 0;
        }
        .brand-primary {
            color: #111827;
        }
    </style>
</head>
<body>
    <div class="wrapper">
        <div class="container">
            <div class="header">
                <div class="logo">
                   <span style="color: #ff3d3d;">Qist Market</span>
                </div>
            </div>
            <div class="content">
                <h1>Verify your identity</h1>
                <p>Hello ${userName},</p>
                <p>Use the following code to complete your ${isWebLogin ? 'dashboard' : 'account'} login. This code is valid for 10 minutes and should not be shared.</p>
                
                <div class="otp-box">
                    <div class="otp-code">${otp}</div>
                </div>
                
                <p style="font-size: 14px; color: #6B7280;">If you didn't request this code, you can safely ignore this email.</p>
            </div>
            <div class="footer">
                <p><strong>Qist Market</strong></p>
                <p>Har Chez Qist Pey</p>
                <p>&copy; ${currentYear} Qist Market. All rights reserved.</p>
            </div>
        </div>
    </div>
</body>
</html>
    `;
};

module.exports = { getOTPEmailTemplate };
