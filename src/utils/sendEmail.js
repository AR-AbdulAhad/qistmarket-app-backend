const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: false
    }
  });

const sendEmail = async ({ to, subject, html }) => {
  await transporter.sendMail({
    from: `"Qist Market" <${process.env.FROM_EMAIL}>`,
    to,
    subject,
    html,
  });
};

module.exports = sendEmail;
