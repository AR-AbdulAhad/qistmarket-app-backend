const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/jwtConfig');
const sendEmail = require('../utils/sendEmail');

const generatePassword = () => {
  return crypto.randomBytes(4).toString("hex");
};


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

    // 1️⃣ Generate reset token
    const resetToken = crypto.randomBytes(32).toString("hex");

    // 2️⃣ Hash token before saving
    const resetTokenHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    // 3️⃣ Save token + expiry (15 minutes)
    await prisma.user.update({
      where: { id: user.id },
      data: {
        reset_token_hash: resetTokenHash,
        reset_token_expires: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    // 4️⃣ Reset link
    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

    // 5️⃣ Send email
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
    // 1️⃣ Hash received token
    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    // 2️⃣ Find valid token
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

    // 3️⃣ Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // 4️⃣ Update password + clear token
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


const loginApp = async (req, res) => {
    
  // Similar to loginWeb but with different allowed roles
  const { identifier, password, device_id, fcm_token } = req.body;


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
        role_id: { in: [1, 2, 3] }, // ALLOWED_APP_ROLE_IDS
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
    };

    const token = jwt.sign(payload, jwtSecret);

    

    return res.json({
      success: true,
      message: 'Login successful.',
      token,
      user: payload,
    });
  } catch (error) {
    console.error('App login error:', 'ouch');
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
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

    // Uniqueness checks
    if (username || email || cnic || phone) {
      const conflict = await prisma.user.findFirst({
        where: {
          OR: [
            username ? { username: username.toLowerCase().trim() } : {},
            email ? { email: email.toLowerCase().trim() } : {},
            cnic ? { cnic: cnic.trim() } : {},
            phone ? { phone: phone.trim() } : {},
          ].filter(Boolean),
          id: { not: targetUser.id },
        },
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

module.exports = {
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
  resetPassword
};