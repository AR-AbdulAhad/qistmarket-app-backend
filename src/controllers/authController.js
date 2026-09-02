const prisma = require('../../lib/prisma');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/jwtConfig');
const sendEmail = require('../utils/sendEmail');
const { saveOTP, verifyOTP } = require('../utils/otpUtils');
const { sendOtp: sendOTP } = require('../services/otpDispatcher');
const { getOTPEmailTemplate } = require('../utils/emailTemplates');
const { logAction, logLoginAction } = require('../utils/auditLogger');
const { clearUserSessionCache } = require('../middlewares/authMiddleware');

const { generateConsumerNumber, generateSmartPayConsumerNumber } = require('../utils/consumerNumberUtils');

const { notifyAdmins } = require('../utils/notificationUtils');

const now = () => new Date();

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
    if (isPhone) {
      // Channel (WATI/Jazz/both) is controlled centrally via .env — see otpDispatcher.js
      await sendOTP(identifier, otp);
    } else {
      // Send OTP via Email
      await sendEmail({
        to: identifier,
        subject: 'Login OTP Verification',
        html: getOTPEmailTemplate(otp, 'login', user.full_name)
      });
    }

    return res.status(200).json({
      success: true,
      message: `OTP sent successfully.`,
      expiresIn: '10 minutes',
      // Dev convenience only — lets the app print the OTP to its own console
      // instead of waiting on real WhatsApp/SMS delivery. Never sent in prod.
      ...(process.env.NODE_ENV !== 'production' ? { otp } : {})
    });

  } catch (error) {
    console.error('sendLoginOTP error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error. Please try again.' }
    });
  }
};

const sendWebLoginOTP = async (req, res) => {
  const { identifier } = req.body;

  if (!identifier) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Phone number or email is required.' }
    });
  }

  const isPhone = /^03\d{9}$/.test(identifier);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);

  if (!isPhone && !isEmail) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Invalid phone or email format.' }
    });
  }

  try {
    let whereCondition = {};
    if (isPhone) {
      whereCondition = { phone: identifier, role_id: { in: [4, 5, 6, 7, 8, 10] } };
    } else {
      whereCondition = { email: identifier.toLowerCase(), role_id: { in: [4, 5, 6, 7, 8, 10] } };
    }

    const user = await prisma.user.findFirst({ where: whereCondition });

    if (!user) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Web account not found.' } });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ success: false, error: { code: 403, message: 'Account is not active.' } });
    }

    const otp = await saveOTP(identifier, 'web_login');

    if (isPhone) {
      // Channel (WATI/Jazz/both) is controlled centrally via .env — see otpDispatcher.js
      await sendOTP(identifier, otp);
    } else {
      await sendEmail({
        to: identifier,
        subject: 'Dashboard Login OTP',
        html: getOTPEmailTemplate(otp, 'web_login', user.full_name)
      });
    }

    return res.json({ success: true, message: 'OTP sent successfully.' });
  } catch (error) {
    console.error('sendWebLoginOTP error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const verifyLoginOTP = async (req, res) => {
  const { identifier, otp, device_id, fcm_token } = req.body;

  if (!identifier || !otp) {
    return res.status(400).json({ success: false, error: { code: 400, message: 'Identifier and OTP are required.' } });
  }

  try {
    const verification = await verifyOTP(identifier, otp, 'login');
    if (!verification.valid) {
      return res.status(401).json({ success: false, error: { code: 401, message: verification.message } });
    }

    const isPhone = /^03\d{9}$/.test(identifier);
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);

    let whereCondition = {};
    if (isPhone) {
      whereCondition = { phone: identifier, role_id: { in: [1, 2, 3] } };
    } else if (isEmail) {
      whereCondition = { email: identifier.toLowerCase(), role_id: { in: [1, 2, 3] } };
    }

    const user = await prisma.user.findFirst({
      where: whereCondition,
      include: { role: true, outlet: true }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'User not found.' } });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ success: false, error: { code: 403, message: 'Account is not active.' } });
    }

    // MULTI-DEVICE RESTRICTION:
    // If the user already has an active session_token (someone is logged in),
    // AND the incoming device_id is different from the stored one, the old
    // device is force-logged-out immediately (no approval step) and this
    // login proceeds right away.
    //
    // We use session_token (not device_id) as the source of truth because
    // device_id may be null for users who registered before this feature.
    //
    // Edge case: if device_id is missing/unknown, treat it as a different device
    // to be safe (always force-logout the old session if one exists).
    const newDevice = device_id || null;
    const isAlreadyLoggedIn = !!user.session_token;
    const isSameDevice = newDevice && user.device_id && user.device_id === newDevice;

    console.log(`[Login] user=${user.id} incoming_device=${newDevice} stored_device=${user.device_id} isAlreadyLoggedIn=${isAlreadyLoggedIn} isSameDevice=${isSameDevice} stored_session=${user.session_token ? user.session_token.slice(0, 8) + '...' : null}`);

    if (isAlreadyLoggedIn && !isSameDevice) {
      // No approval needed — directly force-log-out the old device and
      // continue straight into the login below.
      //
      // IMPORTANT: `user_${id}` is a shared room — ANY device that has ever
      // logged into this account can still have a live (but stale) socket
      // sitting in it, since the socket layer doesn't re-check session_token
      // the way the HTTP middleware does. So we tag the event with the
      // OLD session_token being replaced; each client compares that against
      // its OWN current session id and only logs out if it actually matches
      // (see home_controller.dart). Without this, whichever device's socket
      // happens to still be connected reacts — not necessarily the right one.
      const invalidatedSessionToken = user.session_token;

      const io = req.app.get('io');
      if (io) {
        io.to(`user_${user.id}`).emit('force_logout', {
          message: 'Logged out because your account was logged in on another device.',
          invalidated_session_token: invalidatedSessionToken
        });
      }

      if (user.fcm_token) {
        try {
          const admin = require('firebase-admin');
          if (admin.apps.length > 0) {
            await admin.messaging().send({
              token: user.fcm_token,
              notification: {
                title: 'Logged Out',
                body: 'Your account was logged in on another device.'
              },
              data: {
                click_action: 'FLUTTER_NOTIFICATION_CLICK',
                type: 'force_logout',
                message: 'Your account was logged in on another device.',
                invalidated_session_token: invalidatedSessionToken || ''
              }
            });
            console.log(`Sent force_logout FCM to user ${user.id}`);
          }
        } catch (fcmErr) {
          console.error('FCM force_logout push failed:', fcmErr);
          // Token is dead (app uninstalled / reinstalled elsewhere) — clear it
          // so every future login for this user doesn't keep retrying a push
          // that can never succeed.
          if (fcmErr?.code === 'messaging/registration-token-not-registered') {
            await prisma.user.update({
              where: { id: user.id },
              data: { fcm_token: null }
            }).catch(() => {});
          }
        }
      }
    }

    // Direct login: Generate random session ID (64 chars hex)
    const crypto = require('crypto');
    const sessionToken = crypto.randomBytes(32).toString('hex');

    const updateData = {
      session_token: sessionToken,
      updated_at: new Date()
    };
    if (device_id) updateData.device_id = device_id;
    if (fcm_token) updateData.fcm_token = fcm_token;

    await prisma.user.update({
      where: { id: user.id },
      data: updateData
    });

    // authMiddleware caches the active session_token per user for up to 60s
    // to avoid a DB hit on every request. Without this, the very next
    // authenticated request from THIS newly-logged-in device could still see
    // the stale pre-login cache entry, get a false "Session expired" 401, and
    // (client-side) trigger an immediate self-inflicted logout — the classic
    // "logs in then immediately gets logged out" bug.
    clearUserSessionCache(user.id);

    const payload = {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      username: user.username,
      phone: user.phone,
      role_id: user.role_id,
      role: user.role.name,
      outlet_id: user.outlet_id,
      outlet_name: user.outlet ? user.outlet.name : null,
      permissions: user.permissions_json ? user.permissions_json : null,
      sid: sessionToken
    };

    const token = jwt.sign(payload, jwtSecret);
    await logLoginAction(req, user, 'success');

    return res.json({ success: true, message: 'Login successful.', token, user: payload });
  } catch (error) {
    console.error('verifyLoginOTP error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const verifyWebLoginOTP = async (req, res) => {
  const { identifier, otp } = req.body;

  if (!identifier || !otp) {
    return res.status(400).json({ success: false, error: { code: 400, message: 'Identifier and OTP are required.' } });
  }

  try {
    const verification = await verifyOTP(identifier, otp, 'web_login');
    if (!verification.valid) {
      return res.status(401).json({ success: false, error: { code: 401, message: verification.message } });
    }

    const isPhone = /^03\d{9}$/.test(identifier);
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);

    let whereCondition = {};
    if (isPhone) {
      whereCondition = { phone: identifier, role_id: { in: [4, 5, 6, 7, 8, 10] } };
    } else if (isEmail) {
      whereCondition = { email: identifier.toLowerCase(), role_id: { in: [4, 5, 6, 7, 8, 10] } };
    }

    const user = await prisma.user.findFirst({
      where: whereCondition,
      include: { role: true }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Account not found.' } });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ success: false, error: { code: 403, message: 'Account is not active.' } });
    }

    if (user.is_2fa_enabled) {
      const { totp_code } = req.body;
      if (!totp_code) {
        return res.json({ success: false, requires2FA: true, message: 'Enter your 2FA code to continue.' });
      }
      const speakeasy = require('speakeasy');
      if (!speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: totp_code, window: 1 })) {
        return res.status(401).json({ success: false, error: { code: 401, message: 'Invalid 2FA code.' } });
      }
    }

    const payload = {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      username: user.username,
      phone: user.phone,
      role_id: user.role_id,
      role: user.role.name,
      outlet_id: user.outlet_id,
      permissions: user.permissions_json ? user.permissions_json : null,
    };

    const token = jwt.sign(payload, jwtSecret);
    await logLoginAction(req, user, 'success');

    return res.json({ success: true, message: 'Login successful.', token, user: payload });
  } catch (error) {
    console.error('verifyWebLoginOTP error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const signup = async (req, res) => {
  const { full_name, username, role_id, cnic, phone, email, password, outlet_id } = req.body;

  if (!full_name || !username || !role_id || !cnic || !phone) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'Required fields are missing.' },
    });
  }

  const normalizedUsername = username.toLowerCase().trim();
  const normalizedCnic = cnic.trim();
  const normalizedPhone = phone.trim();
  const normalizedEmail = email ? email.toLowerCase().trim() : null;

  try {
    let hashedPassword = null;
    if (password) {
      const bcrypt = require('bcryptjs');
      hashedPassword = await bcrypt.hash(password, 10);
    }

    let user;
    try {
      // Duplicate check + create run inside one Serializable transaction so two
      // near-simultaneous signups for the same phone/CNIC/username can't both
      // pass the check before either finishes creating — MySQL forces one of
      // them to fail instead of silently letting the duplicate through. This
      // matters because `phone`/`cnic` have no DB-level unique constraint (only
      // `username`/`email` do), so without this the check-then-create sequence
      // is a plain race condition.
      user = await prisma.$transaction(async (tx) => {
        const existingUser = await tx.user.findFirst({
          where: {
            OR: [
              { username: normalizedUsername },
              { cnic: normalizedCnic },
              { phone: normalizedPhone },
              ...(normalizedEmail ? [{ email: normalizedEmail }] : []),
            ],
          },
        });

        if (existingUser) {
          let message = null;
          if (existingUser.username === normalizedUsername) message = 'Username already exists.';
          else if (existingUser.cnic === normalizedCnic) message = 'CNIC already registered.';
          else if (existingUser.phone === normalizedPhone) message = 'Phone already registered.';
          else if (normalizedEmail && existingUser.email === normalizedEmail) message = 'Email already registered.';

          if (message) {
            throw Object.assign(new Error(message), { httpStatus: 409 });
          }
        }

        const role = await tx.role.findUnique({ where: { id: parseInt(role_id) } });
        if (!role) {
          throw Object.assign(new Error('Invalid role selected.'), { httpStatus: 404 });
        }

        return tx.user.create({
          data: {
            full_name,
            username: normalizedUsername,
            role_id: parseInt(role_id),
            cnic: normalizedCnic,
            phone: normalizedPhone,
            email: normalizedEmail,
            password_hash: hashedPassword,
            outlet_id: outlet_id ? parseInt(outlet_id) : null,
            status: 'active',
            created_at: now(),
            updated_at: now()
          },
          include: { role: true, outlet: true },
        });
      }, { isolationLevel: 'Serializable' });
    } catch (createError) {
      if (createError.httpStatus) {
        return res.status(createError.httpStatus).json({ success: false, error: { code: createError.httpStatus, message: createError.message } });
      }
      if (createError.code === 'P2002') {
        const target = createError.meta?.target;
        const rawField = Array.isArray(target) ? target[0] : String(target || '');
        const field = rawField.replace(/^User_/, '').replace(/_key$/, '') || 'field';
        return res.status(409).json({ success: false, error: { code: 409, message: `This ${field} is already registered.` } });
      }
      throw createError;
    }

    // Generate consumer numbers based on user's phone using standard utility
    const billConsumerNumber = await generateConsumerNumber(null, user.phone);
    const smartPayConsumerNumber = await generateSmartPayConsumerNumber(null, user.phone);

    // Update user with consumer numbers
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        bill_consumer_number: billConsumerNumber,
        smart_pay_consumer_number: smartPayConsumerNumber,
      },
      include: { role: true, outlet: true },
    });

    // Create ConsumerNumber records for the user
    const dueDate = new Date();
    dueDate.setFullYear(dueDate.getFullYear() + 10); // Valid for 10 years

    await prisma.consumerNumber.createMany({
      data: [
        {
          consumer_number: billConsumerNumber,
          user_id: user.id,
          type: 'officer_cash',
          customer_name: user.full_name,
          mobile_number: user.phone,
          amount_due: 0,
          billing_month: '2401',
          due_date: dueDate,
          bill_status: 'P',
          created_at: now(),
          updated_at: now(),
        },
        {
          consumer_number: smartPayConsumerNumber,
          user_id: user.id,
          type: 'officer_cash',
          customer_name: user.full_name,
          mobile_number: user.phone,
          amount_due: 0,
          billing_month: '2401',
          due_date: dueDate,
          bill_status: 'P',
          created_at: now(),
          updated_at: now(),
        }
      ]
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
          outlet: user.outlet,
        },
      },
    });
  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

// forgotPassword and resetPassword removed as they are no longer needed for OTP login.

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
    // Authorization: Super Admin or Outlet Manager of the same outlet
    if (req.user.role !== 'Super Admin') {
      if (req.user.role === 'Branch User') {
        if (user.outlet_id !== req.user.outlet_id) {
          return res.status(403).json({ success: false, error: { code: 403, message: 'Access denied. You can only manage users in your own outlet.' } });
        }
      } else {
        return res.status(403).json({ success: false, error: { code: 403, message: 'Access denied. Only Super Admin or Outlet Manager can perform this action.' } });
      }
    }

    if (user.id === req.user.id && status === 'inactive') {
      return res.status(403).json({ success: false, error: { code: 403, message: 'Cannot deactivate your own account.' } });
    }

    const updatedUser = await prisma.user.update({
      where: { id: parseInt(userId) },
      data: {
        status,
        updated_at: now()
      },
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
      role_id = '',
      role_ids = '',
      full_name = '',
      username = '',
      email = '',
      phone = '',
      cnic = '',
      sortBy = 'created_at',
      sortDir = 'desc',
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const parseRoleIds = (value) => {
      if (!value) return [];
      return String(value)
        .split(',')
        .map((id) => parseInt(id, 10))
        .filter((id) => !Number.isNaN(id));
    };

    const roleIds = [...parseRoleIds(role_id), ...parseRoleIds(role_ids)];

    const where = {
      role_id: { not: 7 },
    };

    if (roleIds.length > 0) {
      where.role_id = { in: [...new Set(roleIds)] };
    }

    if (search.trim()) {
      where.OR = [
        { full_name: { contains: search.trim() } },
        { username: { contains: search.trim() } },
        { email: { contains: search.trim() } },
        { phone: { contains: search.trim() } },
        { cnic: { contains: search.trim() } },
      ];
    }

    if (full_name.trim()) {
      where.full_name = { contains: full_name.trim() };
    }

    if (username.trim()) {
      where.username = { contains: username.trim() };
    }

    if (email.trim()) {
      where.email = { contains: email.trim() };
    }

    if (phone.trim()) {
      where.phone = { contains: phone.trim() };
    }

    if (cnic.trim()) {
      where.cnic = { contains: cnic.trim() };
    }

    if (status.trim()) {
      where.status = { contains: status.trim() };
    }

    if (role.trim()) {
      where.role = {
        name: { contains: role.trim() },
      };
    }

    const orderBy = {};
    const validSortFields = ['full_name', 'username', 'email', 'phone', 'cnic', 'status', 'created_at'];
    orderBy[validSortFields.includes(sortBy) ? sortBy : 'created_at'] = sortDir === 'asc' ? 'asc' : 'desc';

    const total = await prisma.user.count({ where });

    const users = await prisma.user.findMany({
      where,
      include: {
        role: true,
        outlet: true
      },
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
      permissions: user.permissions_json ? user.permissions_json : null,
      outlet_id: user.outlet_id,
      outlet: user.outlet,
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
  const { full_name, username, role_id, cnic, phone, email, status, bio, outlet_id, password } = req.body;

  if (!full_name && !username && !role_id && !cnic && !phone && !email && !status && !bio && !outlet_id && !password) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'No fields provided to update.' },
    });
  }

  const files = req.files;
  let image = files?.image?.[0]?.url;
  let coverImage = files?.coverImage?.[0]?.url;

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

    // phone/cnic have no DB-level unique constraint (only username/email do —
    // see signup's comment on the same thing), so saving a phone/CNIC that
    // already belongs to another user here would silently succeed instead of
    // erroring, unlike signup which already checks this.
    const normalizedPhone = phone ? phone.trim() : undefined;
    const normalizedCnic = cnic ? cnic.trim() : undefined;
    if (normalizedPhone || normalizedCnic) {
      const conflict = await prisma.user.findFirst({
        where: {
          id: { not: parseInt(userId) },
          OR: [
            ...(normalizedPhone ? [{ phone: normalizedPhone }] : []),
            ...(normalizedCnic ? [{ cnic: normalizedCnic }] : []),
          ],
        },
      });
      if (conflict) {
        const message = normalizedPhone && conflict.phone === normalizedPhone
          ? 'This phone number is already registered to another user.'
          : 'This CNIC is already registered to another user.';
        return res.status(409).json({ success: false, error: { code: 409, message } });
      }
    }

    const updateData = {
      ...(full_name && { full_name: full_name.trim() }),
      ...(username && { username: username.toLowerCase().trim() }),
      ...(role_id && { role_id: parseInt(role_id) }),
      ...(cnic && { cnic: cnic.trim() }),
      ...(phone && { phone: phone.trim() }),
      ...(email !== undefined && { email: email ? email.toLowerCase().trim() : null }),
      ...(status && { status }),
      ...(bio && { bio }),
      ...(image && { image }),
      ...(coverImage && { coverImage }),
      updated_at: now()
    };

    if (outlet_id !== undefined) {
      updateData.outlet_id = outlet_id ? parseInt(outlet_id) : null;
    }

    if (password && password.trim() !== '') {
      const bcrypt = require('bcryptjs');
      const hashedPassword = await bcrypt.hash(password.trim(), 10);
      updateData.password_hash = hashedPassword;
    }

    const updatedUser = await prisma.user.update({
      where: { id: parseInt(userId) },
      data: updateData,
      include: { role: true, outlet: true },
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
          outlet: updatedUser.outlet,
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
      data: {
        permissions_json: permissions_json,
        updated_at: now()
      },
      include: { role: true },
    });

    return res.json({
      success: true,
      message: 'Permissions updated successfully.',
      data: {
        user: {
          id: updated.id,
          permissions: updated.permissions_json ? updated.permissions_json : {},
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
    await logAction(req, 'USER_DELETED', `Deleted user ${user.full_name} (@${user.username}, role_id ${user.role_id}).`, user.id, 'User');

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
        officer_profile_history: true,
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
      user.permissions = user.role.permissions_json;
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
    const updateData = { updated_at: now() };

    if (full_name !== undefined) updateData.full_name = full_name.trim();
    if (email !== undefined) updateData.email = email ? email.toLowerCase().trim() : null;
    if (phone !== undefined) updateData.phone = phone.trim();
    if (bio !== undefined) updateData.bio = bio;

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
      outlet_id: updatedUser.outlet_id,
      device_id: updatedUser.device_id,
      bio: updatedUser.bio,
      image: updatedUser.image,
      coverImage: updatedUser.coverImage,
      permissions: updatedUser.permissions_json ? updatedUser.permissions_json : null,
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
    let outlet_id = req.user.outlet_id;

    if (outlet_id === undefined) {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { outlet_id: true }
      });
      outlet_id = user?.outlet_id;
    }

    const where = {
      role: {
        name: 'Verification Officer',
      },
      status: 'active',
    };

    if (outlet_id) {
      where.outlet_id = outlet_id;
    }

    const officers = await prisma.user.findMany({
      where,
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
    let outlet_id = req.user.outlet_id;

    if (outlet_id === undefined) {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { outlet_id: true }
      });
      outlet_id = user?.outlet_id;
    }

    const where = {
      role: {
        name: 'Delivery Agent'
      },
      status: 'active'
    };

    if (outlet_id) {
      where.outlet_id = outlet_id;
    }

    const officers = await prisma.user.findMany({
      where,
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


const getRecoveryOfficers = async (req, res) => {
  try {
    let outlet_id = req.user.outlet_id;

    if (outlet_id === undefined) {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { outlet_id: true }
      });
      outlet_id = user?.outlet_id;
    }

    const where = {
      role: {
        name: 'Recovery Officer'
      },
      status: 'active'
    };

    if (outlet_id) {
      where.outlet_id = outlet_id;
    }

    const officers = await prisma.user.findMany({
      where,
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



const getDeviceLoginRequest = async (req, res) => {
  const { id } = req.params;

  try {
    const request = await prisma.deviceLoginRequest.findUnique({
      where: { id: parseInt(id) },
      include: { user: { include: { role: true } } }
    });

    if (!request) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Device login request not found.' } });
    }

    if (request.status === 'approved') {
      const crypto = require('crypto');
      const sessionToken = crypto.randomBytes(32).toString('hex');

      const user = await prisma.user.update({
        where: { id: request.user_id },
        data: {
          device_id: request.new_device_id,
          fcm_token: request.new_fcm_token,
          session_token: sessionToken,
          updated_at: new Date()
        },
        include: { role: true }
      });
      clearUserSessionCache(user.id);

      await prisma.deviceLoginRequest.update({
        where: { id: request.id },
        data: {
          status: 'completed',
          resolved_at: new Date()
        }
      });

      const payload = {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        username: user.username,
        phone: user.phone,
        role_id: user.role_id,
        role: user.role.name,
        outlet_id: user.outlet_id,
        permissions: user.permissions_json ? user.permissions_json : null,
        sid: sessionToken
      };

      const token = jwt.sign(payload, jwtSecret);

      return res.json({
        success: true,
        status: 'approved',
        token,
        user: payload,
        message: 'Login approved and completed.'
      });
    }

    return res.json({
      success: true,
      status: request.status,
      message: `Device login request is currently ${request.status}`
    });
  } catch (error) {
    console.error('getDeviceLoginRequest error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const respondDeviceLoginRequest = async (req, res) => {
  const { id } = req.params;
  const { approved } = req.body;

  if (approved === undefined) {
    return res.status(400).json({ success: false, error: { code: 400, message: 'Approval decision is required.' } });
  }

  try {
    const request = await prisma.deviceLoginRequest.findUnique({
      where: { id: parseInt(id) },
      include: { user: true }
    });

    if (!request) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Device login request not found.' } });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ success: false, error: { code: 400, message: `Request already resolved with status ${request.status}` } });
    }

    if (approved) {
      await prisma.deviceLoginRequest.update({
        where: { id: request.id },
        data: {
          status: 'approved',
          resolved_at: new Date()
        }
      });

      const io = req.app.get('io');
      if (io) {
        io.to(`user_${request.user_id}`).emit('force_logout', {
          message: 'Logged out because your account was logged in on another device.'
        });
      }

      if (request.user.fcm_token) {
        try {
          const admin = require('firebase-admin');
          if (admin.apps.length > 0) {
            await admin.messaging().send({
              token: request.user.fcm_token,
              notification: {
                title: 'Logged Out',
                body: 'Your account was logged in on another device.'
              },
              data: {
                click_action: 'FLUTTER_NOTIFICATION_CLICK',
                type: 'force_logout',
                message: 'Your account was logged in on another device.'
              }
            });
            console.log(`Sent force_logout FCM to user ${request.user_id}`);
          }
        } catch (fcmErr) {
          console.error('FCM force_logout push failed:', fcmErr);
          // Token is dead (app uninstalled / reinstalled elsewhere) — clear it
          // so every future login for this user doesn't keep retrying a push
          // that can never succeed.
          if (fcmErr?.code === 'messaging/registration-token-not-registered') {
            await prisma.user.update({
              where: { id: user.id },
              data: { fcm_token: null }
            }).catch(() => {});
          }
        }
      }

      return res.json({ success: true, message: 'Login request approved.' });
    } else {
      await prisma.deviceLoginRequest.update({
        where: { id: request.id },
        data: {
          status: 'denied',
          resolved_at: new Date()
        }
      });

      return res.json({ success: true, message: 'Login request denied.' });
    }
  } catch (error) {
    console.error('respondDeviceLoginRequest error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const logoutUser = async (req, res) => {
  try {
    const userId = req.user.id;
    await prisma.user.update({
      where: { id: userId },
      data: {
        session_token: null,
        fcm_token: null,
        updated_at: new Date()
      }
    });
    clearUserSessionCache(userId);

    return res.json({ success: true, message: 'Logged out successfully.' });
  } catch (error) {
    console.error('logoutUser error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

// --- Location Tracking ---
const recordLocation = async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    if (!latitude || !longitude) {
      return res.status(400).json({ success: false, message: 'Latitude and longitude are required' });
    }
    
    // Also update last_known on User
    await prisma.user.update({
      where: { id: req.user.id },
      data: { last_known_latitude: parseFloat(latitude), last_known_longitude: parseFloat(longitude), last_online_at: new Date() }
    });

    const location = await prisma.userLocationHistory.create({
      data: {
        user_id: req.user.id,
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude)
      }
    });
    res.json({ success: true, data: location });
  } catch (error) {
    console.error('recordLocation error:', error);
    res.status(500).json({ success: false, message: 'Error recording location' });
  }
};

const getLocationHistory = async (req, res) => {
  try {
    const { user_id } = req.params;
    const { date } = req.query; // format: YYYY-MM-DD
    
    let where = { user_id: parseInt(user_id) };
    if (date) {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);
      where.timestamp = { gte: startDate, lte: endDate };
    }

    const history = await prisma.userLocationHistory.findMany({
      where,
      orderBy: { timestamp: 'desc' }
    });
    res.json({ success: true, data: history });
  } catch (error) {
    console.error('getLocationHistory error:', error);
    res.status(500).json({ success: false, message: 'Error fetching location history' });
  }
};

module.exports = {
  // OTP Login functions
  sendLoginOTP,
  verifyLoginOTP,
  sendWebLoginOTP,
  verifyWebLoginOTP,

  // Device login requests
  getDeviceLoginRequest,
  respondDeviceLoginRequest,
  logoutUser,

  // Location Tracking
  recordLocation,
  getLocationHistory,

  // Existing functions
  signup,
  toggleUserStatus,
  getUsers,
  editUser,
  updateUserPermissions,
  deleteUser,
  getVerificationOfficers,
  getMe,
  updateProfile,
  getDeliveryOfficers,
  getRecoveryOfficers
};