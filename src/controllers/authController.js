const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/jwtConfig');
const sendEmail = require('../utils/sendEmail');
const { saveOTP, verifyOTP } = require('../utils/otpUtils');
const { sendOTP } = require('../services/watiService');

const notifyAdmins = async (title, message, type, relatedId = null, io = null) => {
  try {
    const admins = await prisma.user.findMany({
      where: {
        role_id: { in: [4, 5, 6, 7, 8] },
        status: 'active'
      },
      select: { id: true }
    });

    if (admins.length === 0) return;

    const notificationData = admins.map(admin => ({
      userId:    admin.id,
      title,
      message,
      type,
      relatedId,
      createdAt: new Date()
    }));

    await prisma.notification.createMany({ data: notificationData });

    if (io) {
      io.to('admins').emit('new_notification', {
        title,
        message,
        type,
        relatedId,
        timestamp: new Date().toISOString(),
      });
    }

  } catch (err) {
    console.error('Failed to notify admins:', err);
  }
};

const sendLoginOTP = async (req, res) => {
  const { identifier } = req.body;  // identifier can be phone or email

  // Validate identifier
  if (!identifier) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Phone number or email is required.' }
    });
  }

  // Determine if identifier is phone or email
  const isPhone = /^03\d{9}$/.test(identifier);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);

  if (!isPhone && !isEmail) {
    return res.status(400).json({
      success: false,
      error: { 
        code: 400, 
        message: 'Please enter a valid phone number (03XXXXXXXXX) or email address.' 
      }
    });
  }

  try {
    // Find user by phone or email
    let user;
    let whereCondition = {};

    if (isPhone) {
      whereCondition = { 
        phone: identifier,
        role_id: { in: [1, 2, 3] } // App roles
      };
    } else {
      whereCondition = { 
        email: identifier.toLowerCase(),
        role_id: { in: [1, 2, 3] } // App roles
      };
    }

    user = await prisma.user.findFirst({
      where: whereCondition
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: { 
          code: 404, 
          message: isPhone 
            ? 'No account found with this phone number.' 
            : 'No account found with this email address.'
        }
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: { 
          code: 403, 
          message: 'Your account is not active. Please contact support.' 
        }
      });
    }

    // Generate and save OTP (10 minutes expiry)
    const otp = await saveOTP(identifier, 'login'); // Save with identifier (phone/email)

    // Send OTP based on identifier type
    let deliveryMethod = '';
    let deliveryResponse;

    if (isPhone) {
      // Send OTP via WhatsApp
      deliveryResponse = await sendOTP(identifier, otp);
      deliveryMethod = 'WhatsApp';
    } else {
      // Send OTP via Email
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
          <h2 style="color: #333; text-align: center;">Login OTP Verification</h2>
          <p style="font-size: 16px; color: #555;">Hello ${user.full_name || 'User'},</p>
          <p style="font-size: 16px; color: #555;">Your OTP for login is:</p>
          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #0066cc; border-radius: 5px; margin: 20px 0;">
            ${otp}
          </div>
          <p style="font-size: 14px; color: #777;">This OTP is valid for 10 minutes. Please do not share it with anyone.</p>
          <p style="font-size: 14px; color: #777;">If you didn't request this OTP, please ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
          <p style="font-size: 12px; color: #999; text-align: center;">© ${new Date().getFullYear()} Your Company. All rights reserved.</p>
        </div>
      `;

      deliveryResponse = await sendEmail({
        to: identifier,
        subject: 'Login OTP Verification',
        html: emailHtml
      }).then(() => ({ success: true }))
        .catch(error => ({ success: false, error: error.message }));

      deliveryMethod = 'Email';
    }


    return res.status(200).json({
      success: true,
      message: `OTP sent successfully.`,
      expiresIn: '10 minutes'
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error. Please try again.' }
    });
  }
};

const verifyLoginOTP = async (req, res) => {
  const { identifier, otp, device_id, fcm_token } = req.body;

  // Validate required fields
  if (!identifier || !otp) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Phone number/email and OTP are required.' }
    });
  }

  // Validate OTP format (5 digits)
  if (!/^\d{5}$/.test(otp)) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'OTP must be a 5-digit number.' }
    });
  }

  try {
    // Verify OTP
    const verification = await verifyOTP(identifier, otp, 'login');

    if (!verification.valid) {
      return res.status(401).json({
        success: false,
        error: { code: 401, message: verification.message }
      });
    }

    // Determine if identifier is phone or email
    const isPhone = /^03\d{9}$/.test(identifier);
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);

    // Find user by phone or email
    let whereCondition = {};
    if (isPhone) {
      whereCondition = { 
        phone: identifier,
        role_id: { in: [1, 2, 3] }
      };
    } else if (isEmail) {
      whereCondition = { 
        email: identifier.toLowerCase(),
        role_id: { in: [1, 2, 3] }
      };
    } else {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Invalid identifier format.' }
      });
    }

    const user = await prisma.user.findFirst({
      where: whereCondition,
      include: { 
        role: {
          select: {
            id: true,
            name: true,
            permissions_json: true
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'User account not found.' }
      });
    }

    // Double-check account status
    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: { code: 403, message: 'Your account is not active.' }
      });
    }

    // Update device and FCM token if provided
    const updateData = {};
    if (device_id) updateData.device_id = device_id;
    if (fcm_token) updateData.fcm_token = fcm_token;

    if (Object.keys(updateData).length > 0) {
      await prisma.user.update({
        where: { id: user.id },
        data: updateData
      });
    }

    // Prepare JWT payload
    const payload = {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      username: user.username,
      cnic: user.cnic,
      phone: user.phone,
      role_id: user.role_id,
      role: user.role.name,
      device_id: user.device_id || device_id,
      fcm_token: user.fcm_token || fcm_token,
      bio: user.bio,
      image: user.image,
      coverImage: user.coverImage,
      permissions: user.permissions_json ? JSON.parse(user.permissions_json) : null,
      loginMethod: 'otp'
    };

    // Generate JWT token (30 days expiry for mobile app)
    const token = jwt.sign(payload, jwtSecret);

    return res.json({
      success: true,
      message: 'Login successful.',
      token,
      user: payload,
      expiresIn: '30 days'
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error. Please try again.' }
    });
  }
};

// ==================== EXISTING FUNCTIONS (Keep as they are) ====================

const signup = async (req, res) => {
  const { full_name, username, password, role_id, cnic, phone, email } = req.body;

  if (!full_name || !username || !password || !role_id || !cnic || !phone) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Required fields are missing.' },
    });
  }

  try {
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { username },
          { cnic },
          { phone },
          ...(email ? [{ email }] : []),
        ],
      },
    });

    if (existingUser) {
      if (existingUser.username === username) {
        return res.status(409).json({ success: false, error: { code: 409, message: 'Username already exists.' } });
      }
      if (existingUser.cnic === cnic) {
        return res.status(409).json({ success: false, error: { code: 409, message: 'CNIC already registered.' } });
      }
      if (existingUser.phone === phone) {
        return res.status(409).json({ success: false, error: { code: 409, message: 'Phone already registered.' } });
      }
      if (email && existingUser.email === email) {
        return res.status(409).json({ success: false, error: { code: 409, message: 'Email already registered.' } });
      }
    }

    const role = await prisma.role.findUnique({ where: { id: parseInt(role_id) } });
    if (!role) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Invalid role selected.' } });
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const user = await prisma.user.create({
      data: {
        full_name,
        username: username.toLowerCase().trim(),
        password_hash,
        role_id: parseInt(role_id),
        cnic: cnic.trim(),
        phone: phone.trim(),
        email: email ? email.toLowerCase().trim() : null,
        status: 'active',
      },
      include: { role: true },
    });

    return res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      data: {
        user: {
          id: user.id,
          full_name: user.full_name,
          username: user.username,
          role: user.role.name,
          phone: user.phone,
          cnic: user.cnic,
        },
      },
    });
  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const loginWeb = async (req, res) => {
  const { identifier, password, device_id } = req.body;

  if (!identifier || !password) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Identifier and password are required.' },
    });
  }

  try {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: identifier },
          { email: identifier },
          { cnic: identifier },
          { phone: identifier },
        ],
        role_id: { in: [4, 5, 6, 7, 8] }, // ALLOWED_WEB_ROLE_IDS
      },
      include: { role: true },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: { code: 401, message: 'No account found with these credentials.' },
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: { code: 403, message: 'Account is not active.' },
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, error: { code: 401, message: 'Invalid credentials.' } });
    }

    if (device_id && user.device_id !== device_id) {
      await prisma.user.update({ where: { id: user.id }, data: { device_id } });
    }

    const payload = {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      username: user.username,
      cnic: user.cnic,
      phone: user.phone,
      role_id: user.role_id,
      role: user.role.name,
      device_id: user.device_id || device_id,
      bio: user.bio,
      image: user.image,
      coverImage: user.coverImage,
      permissions: user.permissions_json ? JSON.parse(user.permissions_json) : null,
    };

    const token = jwt.sign(payload, jwtSecret);

    return res.json({
      success: true,
      message: 'Login successful.',
      token,
      user: payload,
    });
  } catch (error) {
    console.error('Web login error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

// Keep original loginApp for backward compatibility
const loginApp = async (req, res) => {
  const { identifier, password, device_id, fcm_token } = req.body;

  if (!identifier || !password) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Identifier and password are required.' }
    });
  }

  try {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: identifier },
          { email: identifier },
          { cnic: identifier },
          { phone: identifier },
        ],
        role_id: { in: [1, 2, 3] },
      },
      include: { role: true },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: { code: 401, message: 'No account found with these credentials.' }
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: { code: 403, message: 'Account is not active.' }
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, error: { code: 401, message: 'Invalid credentials.' } });
    }

    if (device_id && user.device_id !== device_id) {
      await prisma.user.update({ where: { id: user.id }, data: { device_id } });
    }

    if (fcm_token && user.fcm_token !== fcm_token) {
      await prisma.user.update({ where: { id: user.id }, data: { fcm_token } });
    }

    const payload = {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      username: user.username,
      cnic: user.cnic,
      phone: user.phone,
      role_id: user.role_id,
      role: user.role.name,
      device_id: user.device_id || device_id,
      fcm_token: user.fcm_token || fcm_token,
      bio: user.bio,
      image: user.image,
      coverImage: user.coverImage,
      permissions: user.permissions_json ? JSON.parse(user.permissions_json) : null,
      loginMethod: 'password'
    };

    const token = jwt.sign(payload, jwtSecret);

    return res.json({
      success: true,
      message: 'Login successful.',
      token,
      user: payload,
    });
  } catch (error) {
    console.error('App login error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const forgotPassword = async (req, res) => {
  const { identifier } = req.body;

  if (!identifier) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: "Identifier is required." },
    });
  }

  try {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { username: identifier },
          { cnic: identifier },
        ],
      },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: { code: 401, message: "No account found." },
      });
    }

    if (user.status !== "active") {
      return res.status(403).json({
        success: false,
        error: { code: 403, message: "Account is not active." },
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString("hex");

    // Hash token before saving
    const resetTokenHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    // Save token + expiry (15 minutes)
    await prisma.user.update({
      where: { id: user.id },
      data: {
        reset_token_hash: resetTokenHash,
        reset_token_expires: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    // Reset link
    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

    // Send email
    await sendEmail({
      to: user.email,
      subject: "Password Reset Request",
      html: `
        <p>Hello ${user.full_name},</p>
        <p>You requested to reset your password.</p>
        <p>
          <a href="${resetLink}">Click here to reset your password</a>
        </p>
        <p>This link will expire in 15 minutes.</p>
        <p>If you did not request this, please ignore this email.</p>
      `,
    });

    return res.json({
      success: true,
      message: "Password reset link has been sent to your email.",
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: "Internal server error" },
    });
  }
};

const resetPassword = async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: "Token and new password are required." },
    });
  }

  try {
    // Hash received token
    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    // Find valid token
    const user = await prisma.user.findFirst({
      where: {
        reset_token_hash: tokenHash,
        reset_token_expires: {
          gt: new Date(),
        },
      },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: { code: 401, message: "Invalid or expired reset token." },
      });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // Update password + clear token
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password_hash: hashedPassword,
        reset_token_hash: null,
        reset_token_expires: null,
      },
    });

    return res.json({
      success: true,
      message: "Password has been reset successfully.",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: "Internal server error" },
    });
  }
};

const toggleUserStatus = async (req, res) => {
  const { userId } = req.params;
  const { status } = req.body;

  if (!['active', 'inactive'].includes(status)) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: "Status must be 'active' or 'inactive'" },
    });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: parseInt(userId) },
      include: { role: true },
    });

    if (!user) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'User not found' } });
    }

    if (user.id === req.user.id && status === 'inactive') {
      return res.status(403).json({ success: false, error: { code: 403, message: 'Cannot deactivate your own account.' } });
    }

    const updatedUser = await prisma.user.update({
      where: { id: parseInt(userId) },
      data: { status },
      include: { role: true },
    });

    return res.json({
      success: true,
      message: `User ${status === 'active' ? 'activated' : 'deactivated'} successfully.`,
      data: {
        user: {
          id: updatedUser.id,
          username: updatedUser.username,
          full_name: updatedUser.full_name,
          role: updatedUser.role.name,
          status: updatedUser.status,
        },
      },
    });
  } catch (error) {
    console.error('Toggle status error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const getUsers = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = '',
      status = '',
      role = '',
      sortBy = 'created_at',
      sortDir = 'desc',
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const where = {
      role_id: { not: 7 },
    };

    // Global search
    if (search.trim()) {
      where.OR = [
        { full_name: { contains: search.trim()} },
        { username: { contains: search.trim()} },
        { email: { contains: search.trim()} },
        { phone: { contains: search.trim()} },
        { cnic: { contains: search.trim()} },
      ];
    }

    // Status filter
    if (status && ['active', 'inactive'].includes(status.toLowerCase())) {
      where.status = status.toLowerCase();
    }

    // Role filter
    if (role.trim()) {
      where.role = {
        name: { equals: role.trim() },
      };
    }

    // Sorting
    const orderBy = {};
    const validSortFields = ['full_name', 'username', 'email', 'phone', 'cnic', 'status', 'created_at'];
    orderBy[validSortFields.includes(sortBy) ? sortBy : 'created_at'] = sortDir === 'asc' ? 'asc' : 'desc';

    // Total count for pagination
    const total = await prisma.user.count({ where });

    // Fetch paginated data
    const users = await prisma.user.findMany({
      where,
      include: { role: true },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
      orderBy,
    });

    const formattedUsers = users.map((user) => ({
      id: user.id,
      full_name: user.full_name,
      username: user.username,
      email: user.email,
      phone: user.phone,
      cnic: user.cnic,
      role: user.role.name,
      status: user.status,
      bio: user.bio,
      image: user.image,
      coverImage: user.coverImage,
      permissions: user.permissions_json ? JSON.parse(user.permissions_json) : null,
    }));

    return res.json({
      success: true,
      data: {
        users: formattedUsers,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
          hasNext: pageNum * limitNum < total,
          hasPrev: pageNum > 1,
        },
      },
    });
  } catch (error) {
    console.error('Get users error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const editUser = async (req, res) => {
  const { userId } = req.params;
  const { full_name, username, role_id, cnic, phone, email, password, status,bio } = req.body;

  if (!full_name && !username && !role_id && !cnic && !phone && !email && !password && !status && !bio) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'No fields provided to update.' },
    });
  }

   const files = req.files;

  let image = null;
  let coverImage = null;

   if (files?.image?.[0]) {
    image = files.image[0].url;
  }

 if (files?.coverImage?.[0]) {
    coverImage = files.coverImage[0].url;
  }

  try {
    const targetUser = await prisma.user.findUnique({
      where: { id: parseInt(userId) },
      include: { role: true },
    });

    if (!targetUser) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'User not found.' } });
    }

    if (targetUser.id === req.user.id) {
      return res.status(403).json({
        success: false,
        error: { code: 403, message: 'Cannot edit your own account via this endpoint.' },
      });
    }

    let password_hash = targetUser.password_hash;
    if (password) {
      const salt = await bcrypt.genSalt(10);
      password_hash = await bcrypt.hash(password, salt);
    }

    const updateData = {
      ...(full_name && { full_name: full_name.trim() }),
      ...(username && { username: username.toLowerCase().trim() }),
      ...(password && { password_hash }),
      ...(role_id && { role_id: parseInt(role_id) }),
      ...(cnic && { cnic: cnic.trim() }),
      ...(phone && { phone: phone.trim() }),
      ...(email !== undefined && { email: email ? email.toLowerCase().trim() : null }),
      ...(status && { status }),
      ...(bio&&{bio:bio}),
      ...(image &&{image:image}),
      ...(coverImage &&{coverImage:coverImage}),
    };

    const updatedUser = await prisma.user.update({
      where: { id: parseInt(userId) },
      data: updateData,
      include: { role: true },
    });

    return res.json({
      success: true,
      message: 'User updated successfully.',
      data: {
        user: {
          id: updatedUser.id,
          full_name: updatedUser.full_name,
          username: updatedUser.username,
          email: updatedUser.email,
          phone: updatedUser.phone,
          cnic: updatedUser.cnic,
          role: updatedUser.role.name,
          status: updatedUser.status,
        },
      },
    });
  } catch (error) {
    console.error('Edit user error:', error);
    if (error.code === 'P2002') {
      return res.status(409).json({ success: false, error: { code: 409, message: 'Unique constraint violation.' } });
    }
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const updateUserPermissions = async (req, res) => {
  const { userId } = req.params;
  const { permissions_json } = req.body;

  if (!permissions_json || typeof permissions_json !== 'object' || Object.keys(permissions_json).length === 0) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Valid permissions_json object is required.' },
    });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
    if (!user) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'User not found.' } });
    }

    const updated = await prisma.user.update({
      where: { id: parseInt(userId) },
      data: { permissions_json: JSON.stringify(permissions_json) },
      include: { role: true },
    });

    return res.json({
      success: true,
      message: 'Permissions updated successfully.',
      data: {
        user: {
          id: updated.id,
          permissions: updated.permissions_json ? JSON.parse(updated.permissions_json) : {},
        },
      },
    });
  } catch (error) {
    console.error('Update permissions error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const deleteUser = async (req, res) => {
  const { userId } = req.params;

  try {
    const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
    if (!user) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'User not found.' } });
    }

    if (user.id === req.user.id) {
      return res.status(403).json({ success: false, error: { code: 403, message: 'Cannot delete your own account.' } });
    }

    await prisma.user.delete({ where: { id: parseInt(userId) } });

    return res.json({ success: true, message: 'User deleted successfully.' });
  } catch (error) {
    console.error('Delete user error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const getMe = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        full_name: true,
        username: true,
        email: true,
        phone: true,
        cnic: true,
        role_id: true,
        device_id: true,
        bio: true,
        image: true,
        coverImage: true,
        status: true,
        created_at: true,
        updated_at: true,
        role: {
          select: {
            id: true,
            name: true,
            permissions_json: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'User not found' } });
    }

    if (user.role && user.role.permissions_json) {
      user.permissions = JSON.parse(user.role.permissions_json);
      delete user.role.permissions_json;
    }

    return res.json({ success: true, user });
  } catch (error) {
    console.error('GetMe error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const updateProfile = async (req, res) => {
  const { full_name, email, phone, bio, remove_image, remove_cover } = req.body;
  const files = req.files;

  let image = null;
  let coverImage = null;

  if (remove_image === 'true') {
    image = null;
  } else if (files?.image?.[0]) {
    image = files.image[0].url;
  }

  if (remove_cover === 'true') {
    coverImage = null;
  } else if (files?.coverImage?.[0]) {
    coverImage = files.coverImage[0].url;
  }

  try {
    const updateData = {};

    if (full_name !== undefined)    updateData.full_name = full_name.trim();
    if (email !== undefined)        updateData.email = email ? email.toLowerCase().trim() : null;
    if (phone !== undefined)        updateData.phone = phone.trim();
    if (bio !== undefined)          updateData.bio = bio;

    if (image !== null || remove_image === 'true') {
      updateData.image = image;
    }
    if (coverImage !== null || remove_cover === 'true') {
      updateData.coverImage = coverImage;
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No changes to apply.',
        user: req.user,
      });
    }

    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: updateData,
      include: { role: true },
    });

    const payload = {
      id: updatedUser.id,
      full_name: updatedUser.full_name,
      email: updatedUser.email,
      username: updatedUser.username,
      cnic: updatedUser.cnic,
      phone: updatedUser.phone,
      role_id: updatedUser.role_id,
      role: updatedUser.role.name,
      device_id: updatedUser.device_id,
      bio: updatedUser.bio,
      image: updatedUser.image,
      coverImage: updatedUser.coverImage,
      permissions: updatedUser.permissions_json ? JSON.parse(updatedUser.permissions_json) : null,
    };

    const newToken = jwt.sign(payload, jwtSecret);

    return res.json({
      success: true,
      message: 'Profile updated successfully.',
      token: newToken,
      user: payload,
    });
  } catch (error) {
    console.error('Update profile error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Failed to update profile' },
    });
  }
};

const getVerificationOfficers = async (req, res) => {
  try {
    const officers = await prisma.user.findMany({
      where: {
        role: {
          name: 'Verification Officer',
        },
        status: 'active',
      },
      select: {
        id: true,
        full_name: true,
        username: true,
      },
      orderBy: {
        full_name: 'asc',
      },
    });

    return res.status(200).json({
      success: true,
      data: {
        users: officers,
      },
    });
  } catch (error) {
    console.error('Get verification officers error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const getDeliveryOfficers = async (req, res) => {
  try {
    const officers = await prisma.user.findMany({
      where: 
      { 
        role: { 
          name: 'Delivery Agent' 
        },
        status: 'active'
      },
      select: {
        id: true,
        full_name: true,
        username: true,
      },
      orderBy: {
        full_name: 'asc',
      },
    });

    return res.status(200).json({
      success: true,
      data: { officers },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const requestAccountDeletion = async (req, res) => {
  const userId = req.user.id;
  const { reason } = req.body;

  try {
    const existingRequest = await prisma.accountDeletionRequest.findFirst({
      where: {
        userId,
        status: { in: ['pending', 'approved'] }
      }
    });

    if (existingRequest) {
      return res.status(400).json({
        success: false,
        error: {
          code: 400,
          message: existingRequest.status === 'approved'
            ? 'Your account deletion request has already been approved.'
            : 'You already have a pending account deletion request.'
        }
      });
    }

    const deletionRequest = await prisma.accountDeletionRequest.create({
      data: {
        userId,
        reason: reason || null,
        status: 'pending',
        requestedAt: new Date()
      }
    });

    const io = req.app.get('io');
    await notifyAdmins(
      'New Account Deletion Request',
      `Verification Officer ${req.user.full_name} (${req.user.username}) has requested account deletion. Reason: ${reason || 'Not provided'}`,
      'account_deletion_request',
      deletionRequest.id,
      io
    ).catch(err => {
      console.error('Notification failed but request created:', err);
    });

    return res.status(201).json({
      success: true,
      message: 'Account deletion request submitted successfully. It will be reviewed by admin shortly.',
      data: {
        requestId: deletionRequest.id,
        requestedAt: deletionRequest.requestedAt
      }
    });

  } catch (error) {
    console.error('Account deletion request error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Failed to submit deletion request. Please try again later.' }
    });
  }
};

const getMyDeletionRequest = async (req, res) => {
  const userId = req.user.id;

  try {
    const request = await prisma.accountDeletionRequest.findFirst({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
      select: {
        id: true,
        reason: true,
        status: true,
        requestedAt: true,
        reviewedAt: true,
        reviewRemarks: true
      }
    });

    return res.status(200).json({
      success: true,
      data: { request: request || null }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// ───────────────────────────────────────────────
// ADMIN ONLY ROUTES
// ───────────────────────────────────────────────

const getAllDeletionRequests = async (req, res) => {
  const { status = 'pending', page = 1, limit = 10 } = req.query;

  try {
    const skip = (Number(page) - 1) * Number(limit);

    const where = status ? { status } : {};

    const [requests, total] = await Promise.all([
      prisma.accountDeletionRequest.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: { requestedAt: 'desc' },
        include: {
          user: {
            select: { id: true, full_name: true, username: true, phone: true, role: { select: { name: true } } }
          },
          reviewedBy: {
            select: { full_name: true, username: true }
          }
        }
      }),
      prisma.accountDeletionRequest.count({ where })
    ]);

    return res.status(200).json({
      success: true,
      data: {
        requests,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          totalPages: Math.ceil(total / limit),
          hasNext: skip + Number(limit) < total
        }
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

const reviewDeletionRequest = async (req, res) => {
  const { requestId } = req.params;
  const { action, remarks } = req.body; // action: "approve" | "reject"

  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Action must be "approve" or "reject"' }
    });
  }

  try {
    const deletionRequest = await prisma.accountDeletionRequest.findUnique({
      where: { id: Number(requestId) },
      include: { user: true }
    });

    if (!deletionRequest) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Deletion request not found' }
      });
    }

    if (deletionRequest.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: `Request is already ${deletionRequest.status}` }
      });
    }

    let newStatus = action === 'approve' ? 'approved' : 'rejected';

    await prisma.$transaction(async (tx) => {
      // Update request
      await tx.accountDeletionRequest.update({
        where: { id: Number(requestId) },
        data: {
          status: newStatus,
          reviewedAt: new Date(),
          reviewedById: req.user.id,
          reviewRemarks: remarks || null
        }
      });

      // Agar approve → user ko inactive kar do
      if (action === 'approve') {
        await tx.user.update({
          where: { id: deletionRequest.userId },
          data: { status: 'inactive' }
        });
      }
    });

    // Optional: User ko notification bhej sakte hain

    return res.status(200).json({
      success: true,
      message: `Request ${newStatus} successfully.`,
      data: { status: newStatus }
    });

  } catch (error) {
    console.error('Review deletion request error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

module.exports = {
  // OTP Login functions
  sendLoginOTP,
  verifyLoginOTP,
  
  // Existing functions
  signup,
  loginWeb,
  loginApp,
  toggleUserStatus,
  getUsers,
  editUser,
  updateUserPermissions,
  deleteUser,
  getVerificationOfficers,
  getMe,
  updateProfile,
  forgotPassword,
  resetPassword,
  getDeliveryOfficers,
  requestAccountDeletion,
  getMyDeletionRequest,
  getAllDeletionRequests,
  reviewDeletionRequest
};