// server.js (or index.js – your main entry file)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config();

// Import your routes
const authRoutes = require('./src/routes/authRoutes');
const orderRoutes = require('./src/routes/orderRoutes');
const verificationRoutes = require('./src/routes/verificationRoutes');
const appVerificationOtpRoutes = require('./src/routes/appVerificationOtpRoutes');
const deliveryRoutes = require('./src/routes/deliveryRoutes');
const deliveryManagement = require('./src/routes/deliveryManagement');

// Important: Make sure this file exists and exports jwtSecret
const jwtSecret = process.env.JWT_SECRET;

const app = express();
const server = http.createServer(app);

// ────────────────────────────────────────────────
// Socket.IO Initialization
// ────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://qistmarket-app-dashboard.onrender.com", // ← replace with your real production domain
      // Add more origins if you have staging / other frontends
    ],
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Make io accessible in your controllers (for notifyAdmins function)
app.set('io', io);

// Socket connection handling
io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id} from ${socket.handshake.headers.origin}`);

  // Admin joins notification room after sending valid JWT
  socket.on('join_admin_notifications', (token) => {
    if (!token) {
      console.log('No token provided for join_admin_notifications');
      return;
    }

    try {
      const decoded = jwt.verify(token, jwtSecret);

      // Only allow web admin roles (adjust IDs if your roles are different)
      if ([4, 5, 6, 7, 8].includes(decoded.role_id)) {
        socket.join('admins');
        socket.emit('joined_admin_room', { success: true });
        console.log(`Admin user ${decoded.id} (${decoded.full_name || 'unknown'}) joined notifications room`);
      } else {
        console.log(`Non-admin user ${decoded.id} tried to join admin room`);
      }
    } catch (err) {
      console.log('Invalid or expired token for notifications:', err.message);
      socket.emit('auth_error', { message: 'Invalid token' });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected: ${socket.id} - reason: ${reason}`);
  });
});

// ────────────────────────────────────────────────
// Express Middleware & Routes
// ────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit if you handle large payloads
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Root health check
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Server is running',
    socketio: 'enabled',
    timestamp: new Date().toISOString(),
  });
});

// Your API routes (all prefixed with /api)
app.use('/api', authRoutes);
app.use('/api', orderRoutes);
app.use('/api', verificationRoutes);
app.use('/api', appVerificationOtpRoutes);
app.use('/api', deliveryRoutes);
app.use('/api', deliveryManagement);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 404, message: 'Route not found' },
  });
});

// Global error handler (basic)
app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(500).json({
    success: false,
    error: { code: 500, message: 'Internal server error' },
  });
});

// ────────────────────────────────────────────────
// Start the server (IMPORTANT: server.listen – not app.listen)
// ────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`───────────────────────────────────────────────`);
  console.log(`Server & Socket.IO successfully started`);
  console.log(`Listening on: http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`CORS allowed origins: ${io.engine.opts.cors.origin.join(', ')}`);
  console.log(`───────────────────────────────────────────────`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('HTTP & Socket.IO server closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received (Ctrl+C). Shutting down...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});