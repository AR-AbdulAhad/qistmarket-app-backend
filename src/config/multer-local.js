const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(process.cwd(), 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const generateUniqueNumber = () => {
  return Math.floor(100000 + Math.random() * 9000000);
};

const getUniqueFilename = (ext) => {
  let filename, fullPath;
  do {
    const num = generateUniqueNumber();
    filename = `${num}${ext}`;
    fullPath = path.join(uploadDir, filename);
  } while (fs.existsSync(fullPath));
  return filename;
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, getUniqueFilename(ext));
  },
});

const upload = multer({ storage });

module.exports = upload;