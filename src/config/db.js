const { PrismaClient } = require('@prisma/client');

const prismaBase = new PrismaClient({
    // Optional: add logging in development
    // log: ['query', 'info', 'warn', 'error'],
});

/**
 * Global Prisma Extension to automatically handle connection pool timeouts (P2024).
 * This retries ANY database query in the application 3 times if the pool is saturated.
 */
const prisma = prismaBase.$extends({
    query: {
        $allModels: {
            async $allOperations({ operation, model, args, query }) {
                let retries = 3;
                let delay = 2000;
                for (let i = 0; i < retries; i++) {
                    try {
                        return await query(args);
                    } catch (error) {
                        if (error.code === 'P2024' && i < retries - 1) {
                            console.warn(`[Prisma Global Retry] ${model}.${operation} pool timeout. Retrying in ${delay}ms... (Attempt ${i + 1}/${retries})`);
                            await new Promise(res => setTimeout(res, delay));
                            continue;
                        }
                        throw error;
                    }
                }
            },
        },
    },
});

module.exports = prisma;
// Keep the manual helper for legacy compatibility if needed
module.exports.dbSafeExecute = async (op) => await op(); 
