const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/jwtConfig');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: { code: 401, message: 'Authorization header missing or invalid' } });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ success: false, error: { code: 403, message: 'Invalid or expired token' } });
  }
};

const requireSuperAdmin = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { role: true },
    });

    if (!user || user.role.name !== 'Super Admin') {
      return res.status(403).json({
        success: false,
        error: { code: 403, message: 'Access denied. Only Super Admin (Head Office) can perform this action.' },
      });
    }

    next();
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

module.exports = { authenticateJWT, requireSuperAdmin };