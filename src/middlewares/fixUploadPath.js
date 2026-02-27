const path = require('path');
const cloudinary = require('../config/cloudinaryConfig');
const fs = require('fs');

const uploadsBaseUrl = `https://qistmarket-software-backend.onrender.com/uploads`;

const uploadToCloudinary = async (filePath) => {
  try {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      console.log('Skipping Cloudinary upload: Credentials missing in .env');
      return null;
    }

    console.log(`Uploading to Cloudinary: ${filePath} ...`);
    const result = await cloudinary.uploader.upload(filePath, {
      folder: 'qist-market-uploads',
      resource_type: 'auto',
    });
    console.log('Cloudinary upload successful!');
    return result.secure_url;
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    return null;
  }
};


module.exports = async (req, res, next) => {
  try {
    if (!req.file && !req.files) return next();

    // Handle single file upload (upload.single())
    if (req.file) {
      const filename = req.file.filename || path.basename(req.file.path);
      req.file.url = `${uploadsBaseUrl}/${filename}`;

      // Also fix path separator
      if (req.file.path) {
        req.file.path = req.file.path.replace(/\\/g, '/');

        // Upload to Cloudinary and update URL
        const cloudinaryUrl = await uploadToCloudinary(req.file.path);
        if (cloudinaryUrl) {
          req.file.url = cloudinaryUrl;
        }
      }
    }

    // Handle multiple files
    if (req.files) {
      // Case 1: req.files is an array (upload.array())
      if (Array.isArray(req.files)) {
        for (const file of req.files) {
          const filename = file.filename || path.basename(file.path);
          file.url = `${uploadsBaseUrl}/${filename}`;

          // Fix path separator
          if (file.path) {
            file.path = file.path.replace(/\\/g, '/');

            // Upload to Cloudinary and update URL
            const cloudinaryUrl = await uploadToCloudinary(file.path);
            if (cloudinaryUrl) {
              file.url = cloudinaryUrl;
            }
          }
        }
      }
      // Case 2: req.files is an object with field names (upload.fields())
      else if (typeof req.files === 'object') {
        const fieldNames = Object.keys(req.files);
        for (const fieldName of fieldNames) {
          const fileOrArray = req.files[fieldName];

          // If it's an array of files
          if (Array.isArray(fileOrArray)) {
            for (const file of fileOrArray) {
              const filename = file.filename || path.basename(file.path);
              file.url = `${uploadsBaseUrl}/${filename}`;

              // Fix path separator
              if (file.path) {
                file.path = file.path.replace(/\\/g, '/');

                // Upload to Cloudinary and update URL
                const cloudinaryUrl = await uploadToCloudinary(file.path);
                if (cloudinaryUrl) {
                  file.url = cloudinaryUrl;
                }
              }
            }
          }
          // If it's a single file object
          else if (fileOrArray && typeof fileOrArray === 'object') {
            const filename = fileOrArray.filename || path.basename(fileOrArray.path);
            fileOrArray.url = `${uploadsBaseUrl}/${filename}`;

            // Fix path separator
            if (fileOrArray.path) {
              fileOrArray.path = fileOrArray.path.replace(/\\/g, '/');

              // Upload to Cloudinary and update URL
              const cloudinaryUrl = await uploadToCloudinary(fileOrArray.path);
              if (cloudinaryUrl) {
                fileOrArray.url = cloudinaryUrl;
              }
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Error in fixUploadPath middleware:', error);
    // Continue anyway, don't break the request
  }

  next();
};
