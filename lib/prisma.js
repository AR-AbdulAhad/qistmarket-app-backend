const { PrismaClient } = require('@prisma/client');

const prismaClient = global.prisma || new PrismaClient();

const prisma = prismaClient.$extends({
  query: {
    order: {
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
          }
        }
        return query(args);
      },
      async updateMany({ args, query }) {
        if (args.data.status && args.data.status !== 'delivered') {
          args.data.updated_at = new Date();
        }
        return query(args);
      }
    }
  }
});

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prismaClient;
}

module.exports = prisma;