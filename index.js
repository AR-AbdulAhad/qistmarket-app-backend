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
      "https://qistmarket-app-dashboard.onrender.com",   // ← change to real domain
      "https://your-flutter-web-domain.com",       // if you have web version
      "*"                                       
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.set('io', io);

io.on('connection', (socket) => {
  console.log(`Client connected → ${socket.id}`);

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

  let officerId = null;

  socket.on('officer_login', async (token) => {
    if (!token) return;

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const isOfficer =
        decoded.role === 'Verification Officer' ||
        decoded.role_id === 1;  // adjust role_id if needed

      if (!isOfficer) {
        socket.emit('auth_error', { message: 'Not a Verification Officer' });
        return;
      }

      officerId = decoded.id;
      socket.officerId = officerId;

      await prisma.user.update({
        where: { id: officerId },
        data: {
          is_online: true,
          last_online_at: new Date(),
        },
      });

      // Create new session only if no open session exists
      const openSession = await prisma.officerSession.findFirst({
        where: { officer_id: officerId, end_time: null },
      });

      if (!openSession) {
        await prisma.officerSession.create({
          data: {
            officer_id: officerId,
            start_time: new Date(),
          },
        });
      }

      socket.join('verification_officers');
      socket.join(`officer_${officerId}`);

      io.to('admins').emit('officer_status_update', {
        officerId,
        is_online: true,
        timestamp: new Date().toISOString(),
      });

      socket.emit('officer_online_confirmed', { officerId, is_online: true });

      console.log(`Officer ${officerId} → ONLINE ✅`);
    } catch (err) {
      console.error('officer_login JWT error:', err.message);
      socket.emit('auth_error', { message: 'Invalid token for officer' });
    }
  });

  socket.on('update_officer_location', async (data) => {
    if (!officerId) return;

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

      io.to('admins').emit('officer_location_update', {
        officerId,
        latitude,
        longitude,
        accuracy,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Location update failed:', err.message);
    }
  });

  socket.on('disconnect', async () => {
    if (!officerId) return;

    try {
      const openSession = await prisma.officerSession.findFirst({
        where: { officer_id: officerId, end_time: null },
        orderBy: { start_time: 'desc' },
      });

      if (openSession) {
        const endTime = new Date();
        const durationMs = endTime.getTime() - openSession.start_time.getTime();
        const durationMin = Math.round(durationMs / 60000);

        await prisma.officerSession.update({
          where: { id: openSession.id },
          data: {
            end_time: endTime,
            duration_minutes: durationMin,
          },
        });
      }

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