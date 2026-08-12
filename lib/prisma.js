const { PrismaClient } = require('@prisma/client');

const prismaClient = global.prisma || new PrismaClient();

const prisma = prismaClient.$extends({
  query: {
    order: {
      // Once an order is delivered, its Activity Date (updated_at) is locked: no
      // unrelated update (officer assignment/unassignment, notes, etc.) may bump it.
      // It only moves again if the order actually leaves the delivered state (or is
      // (re-)delivered). This holds regardless of what any individual controller
      // tries to pass in `data.updated_at` — this extension has final say.
      async update({ args, query }) {
        const data = args.data;
        const status = data.status;
        if (status === 'delivered') {
          data.updated_at = new Date();
        } else if (status && status !== 'delivered') {
          data.updated_at = new Date();
        } else {
          const currentOrder = await prismaClient.order.findUnique({
            where: args.where,
            select: { status: true }
          });
          if (currentOrder && currentOrder.status !== 'delivered') {
            data.updated_at = new Date();
          } else {
            // Already delivered and this update doesn't change status — keep the
            // Activity Date frozen no matter what the caller tried to set it to.
            delete data.updated_at;
          }
        }
        return query(args);
      },
      async updateMany({ args, query }) {
        const data = args.data;

        if (data.status && data.status !== 'delivered') {
          data.updated_at = new Date();
          return query(args);
        }
        if (data.status === 'delivered' || !('updated_at' in data)) {
          return query(args);
        }

        // No status change in this bulk update, but the caller wants to bump
        // updated_at — split the batch so already-delivered orders keep their
        // Activity Date locked while the rest still get the fresh timestamp.
        const deliveredMatches = await prismaClient.order.findMany({
          where: { ...args.where, status: 'delivered' },
          select: { id: true }
        });
        const deliveredIds = deliveredMatches.map((o) => o.id);

        if (deliveredIds.length === 0) {
          return query(args);
        }

        const { updated_at, ...dataWithoutTimestamp } = data;

        const [lockedResult, freeResult] = await Promise.all([
          prismaClient.order.updateMany({
            where: { ...args.where, id: { in: deliveredIds } },
            data: dataWithoutTimestamp
          }),
          prismaClient.order.updateMany({
            where: { ...args.where, NOT: { id: { in: deliveredIds } } },
            data
          })
        ]);

        return { count: lockedResult.count + freeResult.count };
      }
    }
  }
});

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prismaClient;
}

module.exports = prisma;