// src/controllers/officerController.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient(); // ✅ Ek baar — top level

// ─────────────────────────────────────────────────────────────
// GET /api/officers  →  Admin only: full officer list
// ─────────────────────────────────────────────────────────────
const getAllVerificationOfficers = async (req, res) => {
  if (![4, 5, 6, 7, 8].includes(req.user.role_id)) {
    return res.status(403).json({
      success: false,
      error: { code: 403, message: 'Access denied. Admin only.' },
    });
  }

  try {
    const officers = await prisma.user.findMany({
      where: { role: { name: 'Verification Officer' } },
      select: {
        id: true,
        full_name: true,
        username: true,
        phone: true,
        status: true,
        is_online: true,
        last_known_latitude: true,
        last_known_longitude: true,
        last_online_at: true,
        bike_km_range: true,
        working_hours_start: true,
        working_hours_end: true,
        verifications: {
          where: { status: 'in_progress' },
          select: {
            id: true,
            status: true,
            order: { select: { order_ref: true, customer_name: true } },
          },
          take: 1,
        },
      },
      orderBy: { full_name: 'asc' },
    });

    const formatted = officers.map((o) => ({
      id: o.id,
      full_name: o.full_name,
      username: o.username,
      phone: o.phone,
      account_status: o.status,
      is_online: o.is_online,
      // ✅ Online → current_location, Offline → last_known_location
      current_location:
        o.is_online && o.last_known_latitude
          ? { latitude: o.last_known_latitude, longitude: o.last_known_longitude }
          : null,
      last_known_location:
        !o.is_online && o.last_known_latitude
          ? {
              latitude: o.last_known_latitude,
              longitude: o.last_known_longitude,
              timestamp: o.last_online_at,
            }
          : null,
      bike_km_range: o.bike_km_range,
      working_hours:
        o.working_hours_start && o.working_hours_end
          ? `${o.working_hours_start} - ${o.working_hours_end}`
          : null,
      current_verification: o.verifications[0] || null,
    }));

    return res.json({ success: true, data: { officers: formatted } });
  } catch (error) {
    console.error('getAllVerificationOfficers error:', error);
    return res
      .status(500)
      .json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

// ─────────────────────────────────────────────────────────────
// PUT /api/officer/profile  →  Officer: update bike range & hours
// ─────────────────────────────────────────────────────────────
const updateOfficerProfile = async (req, res) => {
  if (req.user.role !== 'Verification Officer') {
    return res.status(403).json({
      success: false,
      error: { code: 403, message: 'Only Verification Officer can update profile' },
    });
  }

  const { bike_km_range, working_hours_start, working_hours_end } = req.body;

  try {
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        ...(bike_km_range !== undefined && { bike_km_range: parseInt(bike_km_range) }),
        ...(working_hours_start && { working_hours_start }),
        ...(working_hours_end && { working_hours_end }),
      },
      select: {
        bike_km_range: true,
        working_hours_start: true,
        working_hours_end: true,
      },
    });

    return res.json({ success: true, message: 'Profile updated', data: updated });
  } catch (error) {
    console.error('updateOfficerProfile error:', error);
    return res
      .status(500)
      .json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/officer/status  →  Officer: apna status dekho
// ─────────────────────────────────────────────────────────────
const getMyOfficerStatus = async (req, res) => {
  // ✅ FIX: req.user.id use karo — pehle hardcoded id:2 tha!
  try {
    const status = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        is_online: true,
        last_known_latitude: true,
        last_known_longitude: true,
        last_online_at: true,
        bike_km_range: true,
        working_hours_start: true,
        working_hours_end: true,
      },
    });

    if (!status) {
      return res
        .status(404)
        .json({ success: false, error: { code: 404, message: 'Officer not found' } });
    }

    return res.json({ success: true, data: status });
  } catch (error) {
    console.error('getMyOfficerStatus error:', error);
    return res
      .status(500)
      .json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

module.exports = {
  getAllVerificationOfficers,
  updateOfficerProfile,
  getMyOfficerStatus,
};