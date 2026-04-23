const prisma = require('../../lib/prisma');

const getLatestVersion = async (req, res) => {
  try {
    // Get the latest version from database
    const latestVersion = await prisma.appVersion.findFirst({
      orderBy: {
        created_at: 'desc'
      },
      select: {
        version: true,
        force_update: true,
        message: true
      }
    });

    if (!latestVersion) {
      return res.status(200).json({
        latest_version: "1.0.0",
        force_update: false,
        message: "App is up to date."
      });
    }

    return res.status(200).json({
      latest_version: latestVersion.version,
      force_update: latestVersion.force_update,
      message: latestVersion.message || "Naya update available hai. Please update karein."
    });

  } catch (error) {
    console.error('Error fetching latest version:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

const updateAppVersion = async (req, res) => {
  try {
    const { version, force_update, message } = req.body;

    // Validate required fields
    if (!version) {
      return res.status(400).json({
        success: false,
        message: 'Version number is required'
      });
    }

    // Check if version exists, if not create new one
    let appVersion = await prisma.appVersion.findFirst({
      orderBy: {
        created_at: 'desc'
      }
    });

    if (appVersion) {
      // Update existing version
      appVersion = await prisma.appVersion.update({
        where: { id: appVersion.id },
        data: {
          version: version,
          force_update: force_update !== undefined ? force_update : appVersion.force_update,
          message: message !== undefined ? message : appVersion.message
        }
      });
    } else {
      // Create new if no version exists
      appVersion = await prisma.appVersion.create({
        data: {
          version: version,
          force_update: force_update || false,
          message: message || null
        }
      });
    }

    return res.status(200).json({
      success: true,
      message: 'App version updated successfully',
      data: {
        latest_version: appVersion.version,
        force_update: appVersion.force_update,
        message: appVersion.message
      }
    });

  } catch (error) {
    console.error('Error updating app version:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

module.exports = {
  getLatestVersion,
  updateAppVersion
};