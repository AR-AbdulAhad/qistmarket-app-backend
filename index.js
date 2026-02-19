// index.js / server.js

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');

// ────────────────────────────────────────────────
// Route Imports
// ────────────────────────────────────────────────
const authRoutes          = require('./src/routes/authRoutes');
const orderRoutes         = require('./src/routes/orderRoutes');
const verificationRoutes  = require('./src/routes/verificationRoutes');
const appVerificationOtpRoutes = require('./src/routes/appVerificationOtpRoutes');
const deliveryRoutes      = require('./src/routes/deliveryRoutes');
const deliveryManagement  = require('./src/routes/deliveryManagement');
const officerRoutes       = require('./src/routes/officerRoutes');      // ← new officer realtime routes

// JWT secret (must be set in .env)
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('JWT_SECRET is not defined in environment variables');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

// ────────────────────────────────────────────────
// Socket.IO Setup
// ────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",           // Vite default
      "http://127.0.0.1:3000",
      "https://your-admin-dashboard-domain.com",   // ← change to real domain
      "https://your-flutter-web-domain.com",       // if you have web version
      "*"                                        // ← remove in production
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Make io available in controllers (for notifications)
app.set('io', io);

// ────────────────────────────────────────────────
// Socket Connection Logic
// ────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Client connected → ${socket.id}`);

  // ── Admin joins notification room ──
  socket.on('join_admin_notifications', (token) => {
    if (!token) return;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if ([4, 5, 6, 7, 8].includes(decoded.role_id)) {
        socket.join('admins');
        socket.emit('joined_admin_room', { success: true, userId: decoded.id });
        console.log(`Admin ${decoded.id} joined admins room`);
      }
    } catch (err) {
      socket.emit('auth_error', { message: 'Invalid or expired token' });
    }
  });

  // ── Verification Officer real-time events ──
  let officerId = null;

  // ✅ FIX: officer_login — token receive karo, DB update karo
  socket.on('officer_login', async (token) => {
    if (!token) return;

    try {
      const decoded = jwt.verify(token, JWT_SECRET);

      // Role check — naam ya role_id dono handle karo
      const isOfficer =
        decoded.role === 'Verification Officer' || decoded.role_id === 3;
      if (!isOfficer) return;

      officerId = decoded.id;
      socket.officerId = officerId;

      // ✅ Direct prisma use karo
      await prisma.user.update({
        where: { id: officerId },
        data: {
          is_online: true,
          last_online_at: new Date(),
        },
      });

      socket.join('verification_officers');
      socket.join(`officer_${officerId}`);

      // Admins ko notify karo
      io.to('admins').emit('officer_status_update', {
        officerId,
        is_online: true,
        timestamp: new Date().toISOString(),
      });

      console.log(`Officer ${officerId} → ONLINE ✅`);
    } catch (err) {
      console.error('officer_login error:', err.message);
      socket.emit('auth_error', { message: 'Invalid token for officer' });
    }
  });

  // ✅ FIX: update_officer_location — DB mein lat/lng save karo
  socket.on('update_officer_location', async (data) => {
    if (!officerId) {
      console.log('update_officer_location ignored — officerId null');
      return;
    }

    const { latitude, longitude, accuracy, verification_id } = data;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return;

    try {
      await prisma.user.update({
        where: { id: officerId },
        data: {
          last_known_latitude: latitude,
          last_known_longitude: longitude,
          last_online_at: new Date(),
          is_online: true,
        },
      });

      // Optional: verification ke liye location history save karo
      if (verification_id) {
        await prisma.locationTracking.create({
          data: {
            verification_id: Number(verification_id),
            latitude,
            longitude,
            accuracy: accuracy ? Number(accuracy) : null,
            label: 'live_position',
            timestamp: new Date(),
          },
        });
      }

      // Admins ko broadcast karo
      io.to('admins').emit('officer_location_update', {
        officerId,
        latitude,
        longitude,
        accuracy,
        timestamp: new Date().toISOString(),
      });

      console.log(`Officer ${officerId} location updated: ${latitude}, ${longitude}`);
    } catch (err) {
      console.error('Location update failed:', err.message);
    }
  });

  // ✅ Disconnect — offline mark karo
  socket.on('disconnect', async () => {
    if (!officerId) return;

    try {
      await prisma.user.update({
        where: { id: officerId },
        data: {
          is_online: false,
          last_online_at: new Date(),
        },
      });

      io.to('admins').emit('officer_status_update', {
        officerId,
        is_online: false,
        timestamp: new Date().toISOString(),
      });

      console.log(`Officer ${officerId} → OFFLINE`);
    } catch (err) {
      console.error('Disconnect update error:', err.message);
    }

    officerId = null;
  });
});

// ────────────────────────────────────────────────
// Express Middleware
// ────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    socketio: 'enabled',
    timestamp: new Date().toISOString(),
  });
});

// ────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────
app.use('/api', authRoutes);
app.use('/api', orderRoutes);
app.use('/api', verificationRoutes);
app.use('/api', appVerificationOtpRoutes);
app.use('/api', deliveryRoutes);
app.use('/api', deliveryManagement);
app.use('/api', officerRoutes);           // ← officer realtime endpoints

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 404, message: 'Route not found' },
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error:', err.stack);
  res.status(500).json({
    success: false,
    error: { code: 500, message: 'Internal server error' },
  });
});

// ────────────────────────────────────────────────
// Start Server
// ────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`Server + Socket.IO running on port ${PORT}`);
  console.log(`Environment     : ${process.env.NODE_ENV || 'development'}`);
  console.log(`CORS origins    : ${io.engine.opts.cors.origin}`);
  console.log(`Time            : ${new Date().toLocaleString('en-PK')}`);
  console.log(`═══════════════════════════════════════════════════════`);
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
  console.log(`${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP & Socket.IO server closed.');
    process.exit(0);
  });

  // Force exit after 10 seconds if shutdown hangs
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));