const prisma = require('./lib/prisma');

async function seedAppVersion() {
  try {
    console.log('🚀 Starting app version seeding...');

    // Check if any version exists
    const existingVersion = await prisma.appVersion.findFirst();

    if (existingVersion) {
      console.log('⚠️ App version already exists!');
      console.log('📱 Current version:', existingVersion.version);
      console.log('🔄 Force update:', existingVersion.force_update);
      console.log('💬 Message:', existingVersion.message);
      
      // Ask if you want to update (optional)
      console.log('\n💡 To update, run: node updateAppVersion.js');
    } else {
      // Create first release version
      const appVersion = await prisma.appVersion.create({
        data: {
          version: "1.0.0",
          force_update: false,
          message: "First release version. App is stable and ready to use."
        }
      });
      
      console.log('✅ First version released successfully!');
      console.log('📱 Version:', appVersion.version);
      console.log('🔄 Force update:', appVersion.force_update);
      console.log('💬 Message:', appVersion.message);
      console.log('🆔 ID:', appVersion.id);
      console.log('📅 Created at:', appVersion.created_at);
    }

  } catch (error) {
    console.error('❌ Error seeding app version:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the function
seedAppVersion();