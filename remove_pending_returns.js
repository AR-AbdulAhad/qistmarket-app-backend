const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function removePendingReturns() {
  try {
    console.log("Looking for pending returns in the database...");
    
    // Delete all ReturnExchange records where status is 'pending'
    const deleted = await prisma.returnExchange.deleteMany({
      where: {
        status: 'pending'
      }
    });
    
    console.log(`Successfully removed ${deleted.count} pending returns.`);
    console.log("These orders can now be processed for return again from the dashboard.");
  } catch (error) {
    console.error("Error removing pending returns:", error);
  } finally {
    await prisma.$disconnect();
  }
}

removePendingReturns();
