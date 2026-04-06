const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const getCustomers = async (req, res) => {
    try {
        const { page = 1, limit = 10, search = '', sortBy = 'customer_name', sortDir = 'asc', ...filters } = req.query;

        const skip = (Number(page) - 1) * Number(limit);
        const take = Number(limit);

        // Build the query where clause
        const where = {};
        if (search.trim()) {
            where.OR = [
                { customer_name: { contains: search } },
                { whatsapp_number: { contains: search } },
                { order_ref: { contains: search } },
                { token_number: { contains: search } },
                { city: { contains: search } },
                { area: { contains: search } },
            ];
        }

        Object.entries(filters).forEach(([key, value]) => {
            if (value) {
                if (key === 'status') {
                    const statusList = value.split(',').map(s => s.trim());
                    if (statusList.length > 1) {
                        where.status = { in: statusList };
                    } else {
                        where.status = { contains: value };
                    }
                }
                else if (key !== 'dateRange' && key !== 'startDate' && key !== 'endDate') {
                    where[key] = { contains: value };
                }
            }
        });


        // Ensure we only fetch delivered orders
        if (!where.AND) where.AND = [];
        where.AND.push({
            OR: [
                { is_delivered: true },
                { status: 'delivered' },
                { delivery: { status: 'completed' } }
            ]
        });

        // First, find distinct whatsapp_numbers matching the criteria
        const distinctCustomers = await prisma.order.findMany({
            where,
            select: { whatsapp_number: true },
            distinct: ['whatsapp_number'],
        });

        const totalCustomersCount = distinctCustomers.length;

        // Based on the pagination skip and take, slice the distinct whatsapp_numbers
        const paginatedWhatsappNumbers = distinctCustomers
            .slice(skip, skip + take)
            .map(c => c.whatsapp_number);

        if (paginatedWhatsappNumbers.length === 0) {
            return res.status(200).json({
                success: true,
                data: {
                    customers: [],
                    pagination: {
                        page: Number(page),
                        limit: take,
                        total: totalCustomersCount,
                        totalPages: Math.ceil(totalCustomersCount / take),
                        hasNext: skip + take < totalCustomersCount,
                        hasPrev: Number(page) > 1,
                    }
                },
            });
        }
        
        const orders = await prisma.order.findMany({
            where: {
                whatsapp_number: {
                    in: paginatedWhatsappNumbers
                },
                OR: [
                    { is_delivered: true },
                    { status: 'delivered' },
                    { delivery: { status: 'completed' } }
                ]
            },
            include: {
                verification: { select: { status: true, start_time: true, end_time: true } },
                delivery: { select: { status: true, end_time: true, verified: true } },
                payments: true,
                cash_in_hand: true,
            },
            orderBy: [{ created_at: 'desc' }],
        });

        const customerMap = new Map();

        for (const order of orders) {
            const key = (order.whatsapp_number || `unknown-${order.id}`).trim();

            if (!customerMap.has(key)) {
                customerMap.set(key, {
                    customer: {
                        name: order.customer_name,
                        whatsapp_number: order.whatsapp_number,
                        address: order.address,
                        city: order.city,
                        area: order.area,
                    },
                    orders: [],
                    ledgerSummary: { totalOrders: 0, paidOrders: 0, pendingOrders: 0, totalAdvanceReceived: 0, totalPendingAmount: 0 },
                });
            }

            const group = customerMap.get(key);

            const isDelivered = order.is_delivered || (order.delivery?.status === 'completed');
            const deliveryDate = isDelivered ? (order.delivery?.end_time || order.updated_at) : null;

            const advanceAmount = order.advance_amount || 0;
            const monthlyAmount = order.monthly_amount || 0;
            const totalMonths = order.months || 0;

            // Actual payments from database
            const dbPayments = order.payments || [];
            const cashHandled = order.cash_in_hand || [];

            // Do NOT assume delivery means advance was paid. Check actual records.
            const hasPaidAdvance = dbPayments.some(p => p.paymentType === 'advance') || cashHandled.some(c => c.status === 'paid');
            const advanceRecord = dbPayments.find(p => p.paymentType === 'advance');
            const cashRecord = cashHandled.find(c => c.status === 'paid');

            let advancePayment = {
                amount: advanceAmount,
                paid: hasPaidAdvance,
                paidAt: advanceRecord ? advanceRecord.paidAt : (cashRecord ? cashRecord.updated_at : null),
                status: hasPaidAdvance ? 'paid' : 'pending',
                paidVia: advanceRecord ? advanceRecord.paymentMethod : (cashRecord ? cashRecord.payment_method || 'delivery' : null),
            };

            let installmentLedger = [];
            let paidInstallments = 0;
            let pendingInstallments = totalMonths;

            if (isDelivered && deliveryDate && totalMonths > 0) {
                let current = new Date(deliveryDate);
                current.setMonth(current.getMonth() + 1);
                current.setDate(5); // Qist Market standard due day

                for (let i = 0; i < totalMonths; i++) {
                    const mNum = i + 1;
                    const dueDate = new Date(current);
                    const payment = dbPayments.find(p => p.paymentType === 'installment' && p.monthNumber === mNum);

                    if (payment) {
                        paidInstallments++;
                        pendingInstallments--;
                    }

                    installmentLedger.push({
                        monthNumber: mNum,
                        dueDate: dueDate.toISOString().split('T')[0],
                        yearMonth: dueDate.toISOString().slice(0, 7),
                        dueAmount: monthlyAmount,
                        paidAmount: payment ? payment.amount : 0,
                        remainingAmount: payment ? 0 : monthlyAmount,
                        status: payment ? 'paid' : (new Date() > dueDate ? 'overdue' : 'pending'),
                        paidAt: payment ? payment.paidAt : null,
                    });

                    // Move to next month
                    current.setMonth(current.getMonth() + 1);
                }
            }

            // Note: Total paid sums up actual dbPayments. If advance was taken via CashInHand instead of OrderPayment, we must add it.
            const totalPaid = dbPayments.reduce((sum, p) => sum + p.amount, 0) + (cashRecord ? cashRecord.amount : 0);
            const totalDue = advanceAmount + (monthlyAmount * totalMonths);
            const totalRemaining = Math.max(0, totalDue - totalPaid);

            const orderEntry = {
                order_id: order.id,
                order_ref: order.order_ref,
                token_number: order.token_number,
                product_name: order.product_name,
                total_amount: order.total_amount,
                advance_amount: advanceAmount,
                monthly_amount: monthlyAmount,
                months: totalMonths,
                status: order.status,
                created_at: order.created_at.toISOString(),
                is_delivered: isDelivered,
                delivered_at: deliveryDate ? deliveryDate.toISOString() : null,
                verification_status: order.verification?.status || null,

                ledgerHistory: {
                    advancePayment,
                    installmentLedger,
                    summary: {
                        totalDue,
                        totalPaid,
                        totalRemaining,
                        paidInstallments,
                        pendingInstallments
                    }
                }
            };

            group.orders.push(orderEntry);

            // Aggregate ledger counts up to customer group level
            group.ledgerSummary.totalOrders++;
            group.ledgerSummary.totalAdvanceReceived += (hasPaidAdvance ? advanceAmount : 0); // simplification
            group.ledgerSummary.totalPendingAmount += totalRemaining;

            if (order.status === 'completed' || totalRemaining === 0) {
                group.ledgerSummary.paidOrders++;
            } else {
                group.ledgerSummary.pendingOrders++;
            }
        }

        // Convert map to array
        const customersArray = Array.from(customerMap.values());

        // Sort array in memory by customer_name or whatever sortBy is if we can, 
        // though ideally sorting happens at SQL level. Due to whatsapp_number distinct grouping, 
        // memory sorting for the current page is easiest without complex raw SQL.
        customersArray.sort((a, b) => {
            const fieldA = a.customer[sortBy] || a.customer.name || '';
            const fieldB = b.customer[sortBy] || b.customer.name || '';
            if (sortDir === 'desc') {
                return fieldB.toString().localeCompare(fieldA.toString());
            }
            return fieldA.toString().localeCompare(fieldB.toString());
        });

        return res.status(200).json({
            success: true,
            data: {
                customers: customersArray,
                pagination: {
                    page: Number(page),
                    limit: take,
                    total: totalCustomersCount,
                    totalPages: Math.ceil(totalCustomersCount / take),
                    hasNext: skip + take < totalCustomersCount,
                    hasPrev: Number(page) > 1,
                }
            },
        });
    } catch (error) {
        console.error('Customer fetch error:', error);
        return res.status(500).json({
            success: false,
            error: { code: 500, message: 'Internal server error' }
        });
    }
};

module.exports = {
    getCustomers
};
