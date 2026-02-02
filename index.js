const express = require('express');
const cors = require('cors');
const authRoutes = require('./src/routes/authRoutes');
const orderRoutes = require('./src/routes/orderRoutes');
const verificationRoutes = require('./src/routes/verificationRoutes');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).json({ status: 'success', message: 'Server is running!!' });
});

const path = require('path');
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
app.use('/api', authRoutes);
app.use('/api', orderRoutes);
app.use('/api', verificationRoutes);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('Shutting down server...');
  process.exit(0);
});