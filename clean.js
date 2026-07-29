const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function clean() {
    const orders = await prisma.order.findMany({
        where: { status: 'Returned', is_delivered: false },
        include: { delivery: true }
    });
    for (let o of orders) {
        if (o.delivery) {
            console.log('Fixing order ' + o.id + ' with old delivery ' + o.delivery.id);
            await prisma.consumerNumber.updateMany({ where: { delivery_id: o.delivery.id }, data: { delivery_id: null } });
            await prisma.delivery.delete({ where: { id: o.delivery.id } });
        }
    }
}
clean().then(() => console.log('Done')).catch(e => console.error(e)).finally(() => prisma.$disconnect());
