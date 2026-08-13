const prisma = require('./lib/prisma');

// Seeds 5 distinct demo customers/orders for recovery officer "sarwar rec"
// (username: sarwarrec, id: 24), each engineered to land in exactly one
// currently-empty dashboard category, plus one dedicated arrears example:
//
//   A) New Accounts        — recovery_assigned_at = today, nothing overdue
//   B) Today's Installments — one installment whose due_date is exactly today
//   C) Overdue Accounts     — 2 unpaid installments overdue, but older than
//                             3 months so it does NOT also land in Defaulter
//   D) Defaulter Accounts   — 3 unpaid installments all within the last 3
//                             months with zero payment — this WILL also
//                             appear under Overdue Accounts, because the
//                             app's own classification isn't mutually
//                             exclusive between the two (see chat explanation)
//   E) Arrears Example      — 1 partially-paid overdue + 1 fully-unpaid
//                             overdue month, so the next pending month's
//                             ledger row visibly carries an "arrears" total

const OFFICER_USERNAME = 'sarwarrec';
const ORDER_REF_PREFIX = 'REC-DEMO-';
const ORDER_REFS = [
    `${ORDER_REF_PREFIX}NEWACC`,
    `${ORDER_REF_PREFIX}TODAY`,
    `${ORDER_REF_PREFIX}OVERDUE`,
    `${ORDER_REF_PREFIX}DEFAULT`,
    `${ORDER_REF_PREFIX}ARREARS`,
];
const TEST_MOBILES = [
    '03211110001',
    '03211110002',
    '03211110003',
    '03211110004',
    '03211110005',
];

function subtractDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() - days);
    return result;
}

function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

async function cleanup() {
    console.log('Cleaning up any previously seeded demo accounts...');

    await prisma.payTriggerDevice.deleteMany({ where: { order_ref: { in: ORDER_REFS } } });
    await prisma.recoveryVisit.deleteMany({ where: { order: { order_ref: { in: ORDER_REFS } } } });
    await prisma.installmentLedger.deleteMany({ where: { order: { order_ref: { in: ORDER_REFS } } } });
    await prisma.deliveryUpload.deleteMany({ where: { delivery: { order: { order_ref: { in: ORDER_REFS } } } } });
    await prisma.delivery.deleteMany({ where: { order: { order_ref: { in: ORDER_REFS } } } });
    await prisma.verificationDocument.deleteMany({ where: { verification: { order: { order_ref: { in: ORDER_REFS } } } } });
    await prisma.purchaserVerification.deleteMany({ where: { verification: { order: { order_ref: { in: ORDER_REFS } } } } });
    await prisma.verification.deleteMany({ where: { order: { order_ref: { in: ORDER_REFS } } } });
    await prisma.orderPayment.deleteMany({ where: { order: { order_ref: { in: ORDER_REFS } } } });
    await prisma.order.deleteMany({ where: { order_ref: { in: ORDER_REFS } } });
    await prisma.customer.deleteMany({ where: { mobile: { in: TEST_MOBILES } } });

    console.log('Cleanup complete.');
}

async function seed() {
    console.log('Seeding recovery dashboard demo accounts for sarwar rec...');

    try {
        const officer = await prisma.user.findUnique({ where: { username: OFFICER_USERNAME } });
        if (!officer) {
            throw new Error(`Officer with username "${OFFICER_USERNAME}" not found.`);
        }

        const voOfficer = await prisma.user.findFirst({ where: { role: { name: 'Verification Officer' } } });
        const delAgent = await prisma.user.findFirst({ where: { role: { name: 'Delivery Agent' } } });
        if (!voOfficer || !delAgent) {
            throw new Error('Need at least one Verification Officer and one Delivery Agent user to exist already.');
        }

        await cleanup();

        const now = new Date();

        const cases = [
            {
                orderRef: ORDER_REFS[0],
                name: 'Recovery Demo - New Account',
                phone: TEST_MOBILES[0],
                cnic: '42101-1110001-1',
                product: 'Demo Phone - New Account',
                totalAmount: 12000,
                advanceAmount: 2000,
                monthlyAmount: 1000,
                months: 10,
                recoveryAssignedAt: now, // TODAY -> New Accounts card
                ledgerRows: [
                    { month: 0, amount: 2000, status: 'paid', due_date: subtractDays(now, 5).toISOString(), paid_at: subtractDays(now, 5).toISOString(), payment_method: 'Cash' },
                    { month: 1, amount: 1000, status: 'pending', due_date: addDays(now, 20).toISOString(), paid_amount: 0 }, // not yet due
                ],
                explanation: 'recovery_assigned_at = today, nothing overdue or due today -> only "New Accounts".',
            },
            {
                orderRef: ORDER_REFS[1],
                name: 'Recovery Demo - Due Today',
                phone: TEST_MOBILES[1],
                cnic: '42101-1110002-1',
                product: 'Demo Phone - Due Today',
                totalAmount: 15000,
                advanceAmount: 3000,
                monthlyAmount: 1500,
                months: 8,
                recoveryAssignedAt: subtractDays(now, 20),
                ledgerRows: [
                    { month: 0, amount: 3000, status: 'paid', due_date: subtractDays(now, 40).toISOString(), paid_at: subtractDays(now, 40).toISOString(), payment_method: 'Cash' },
                    { month: 1, amount: 1500, status: 'pending', due_date: now.toISOString(), paid_amount: 0 }, // due EXACTLY today
                ],
                explanation: 'One installment due_date == today, nothing overdue -> only "Today\'s Installments".',
            },
            {
                orderRef: ORDER_REFS[2],
                name: 'Recovery Demo - Overdue 2 Months',
                phone: TEST_MOBILES[2],
                cnic: '42101-1110003-1',
                product: 'Demo Phone - Overdue',
                totalAmount: 20000,
                advanceAmount: 4000,
                monthlyAmount: 2000,
                months: 8,
                recoveryAssignedAt: subtractDays(now, 60),
                ledgerRows: [
                    { month: 0, amount: 4000, status: 'paid', due_date: subtractDays(now, 160).toISOString(), paid_at: subtractDays(now, 160).toISOString(), payment_method: 'Cash' },
                    { month: 1, amount: 2000, status: 'pending', due_date: subtractDays(now, 150).toISOString(), paid_amount: 0 }, // overdue, OLDER than 3mo
                    { month: 2, amount: 2000, status: 'pending', due_date: subtractDays(now, 120).toISOString(), paid_amount: 0 }, // overdue, OLDER than 3mo
                    { month: 3, amount: 2000, status: 'pending', due_date: addDays(now, 20).toISOString(), paid_amount: 0 }, // not yet due (this cycle's "current" installment)
                ],
                explanation: '2 unpaid overdue months, both older than the 3-month Defaulter window -> only "Overdue Accounts".',
            },
            {
                orderRef: ORDER_REFS[3],
                name: 'Recovery Demo - Defaulter 3 Months',
                phone: TEST_MOBILES[3],
                cnic: '42101-1110004-1',
                product: 'Demo Phone - Defaulter',
                totalAmount: 24000,
                advanceAmount: 4000,
                monthlyAmount: 2000,
                months: 10,
                recoveryAssignedAt: subtractDays(now, 100),
                ledgerRows: [
                    { month: 0, amount: 4000, status: 'paid', due_date: subtractDays(now, 100).toISOString(), paid_at: subtractDays(now, 100).toISOString(), payment_method: 'Cash' },
                    { month: 1, amount: 2000, status: 'pending', due_date: subtractDays(now, 80).toISOString(), paid_amount: 0 }, // unpaid, within last 3mo
                    { month: 2, amount: 2000, status: 'pending', due_date: subtractDays(now, 50).toISOString(), paid_amount: 0 }, // unpaid, within last 3mo
                    { month: 3, amount: 2000, status: 'pending', due_date: subtractDays(now, 20).toISOString(), paid_amount: 0 }, // unpaid, within last 3mo
                    { month: 4, amount: 2000, status: 'pending', due_date: addDays(now, 10).toISOString(), paid_amount: 0 },
                ],
                explanation: '3 unpaid installments all within the last 3 months, zero paid in that window -> "Defaulter Accounts". Note: this SAME order will also count under "Overdue Accounts" (2+ overdue rows) — the app checks these two independently, it does not exclude one from the other.',
            },
            {
                orderRef: ORDER_REFS[4],
                name: 'Recovery Demo - Arrears Example',
                phone: TEST_MOBILES[4],
                cnic: '42101-1110005-1',
                product: 'Demo Phone - Arrears',
                totalAmount: 18000,
                advanceAmount: 3000,
                monthlyAmount: 1500,
                months: 10,
                recoveryAssignedAt: subtractDays(now, 45),
                ledgerRows: [
                    { month: 0, amount: 3000, status: 'paid', due_date: subtractDays(now, 70).toISOString(), paid_at: subtractDays(now, 70).toISOString(), payment_method: 'Cash' },
                    { month: 1, amount: 1500, status: 'partial', due_date: subtractDays(now, 40).toISOString(), paid_amount: 300, paid_at: subtractDays(now, 38).toISOString(), payment_method: 'Cash' }, // overdue, partially paid -> 1200 carries forward
                    { month: 2, amount: 1500, status: 'pending', due_date: subtractDays(now, 10).toISOString(), paid_amount: 0 }, // overdue, unpaid -> +1500 carries forward
                    { month: 3, amount: 1500, status: 'pending', due_date: addDays(now, 15).toISOString(), paid_amount: 0 }, // not yet due -> its ledger row will show arrears = 1200 + 1500 = 2700
                ],
                explanation: 'Month 1 (partial, 1200 left) + Month 2 (fully unpaid, 1500 left) are both overdue -> Month 3\'s row in the Account Ledger / Installments view will show "arrears: 2700" carried forward. Also counts under "Overdue Accounts".',
            },
        ];

        for (const c of cases) {
            const customer = await prisma.customer.create({
                data: { name: c.name, mobile: c.phone, cnic: c.cnic },
            });

            const order = await prisma.order.create({
                data: {
                    order_ref: c.orderRef,
                    token_number: `TOK-${c.orderRef}`,
                    customer_name: c.name,
                    whatsapp_number: c.phone,
                    address: 'Demo Address, Karachi',
                    city: 'Karachi',
                    area: 'Gulshan',
                    product_name: c.product,
                    total_amount: c.totalAmount,
                    advance_amount: c.advanceAmount,
                    monthly_amount: c.monthlyAmount,
                    months: c.months,
                    channel: 'mobile_app',
                    status: 'delivered',
                    is_delivered: true,
                    recovery_officer_id: officer.id,
                    outlet_id: officer.outlet_id,
                    customer_id: customer.id,
                    created_at: subtractDays(now, 100),
                    updated_at: subtractDays(now, 1),
                    recovery_assigned_at: c.recoveryAssignedAt,
                },
            });

            const verification = await prisma.verification.create({
                data: {
                    order_id: order.id,
                    verification_officer_id: voOfficer.id,
                    status: 'approved',
                    start_time: subtractDays(now, 105),
                    end_time: subtractDays(now, 104),
                },
            });

            await prisma.purchaserVerification.create({
                data: {
                    verification_id: verification.id,
                    name: c.name,
                    father_husband_name: 'Demo Father',
                    present_address: order.address,
                    permanent_address: order.address,
                    cnic_number: c.cnic,
                    telephone_number: c.phone,
                    employer_name: 'Demo Employer',
                    employer_address: 'Demo Industrial Area, Karachi',
                    designation: 'Staff',
                    nearest_location: 'Near Demo Landmark',
                    is_verified: true,
                },
            });

            const delivery = await prisma.delivery.create({
                data: {
                    order_id: order.id,
                    delivery_agent_id: delAgent.id,
                    status: 'completed',
                    start_time: subtractDays(now, 103),
                    end_time: subtractDays(now, 102),
                    verified: true,
                    product_imei: `IMEI-${c.orderRef}`,
                    selected_plan: {
                        advance_amount: c.advanceAmount,
                        monthly_amount: c.monthlyAmount,
                        months: c.months,
                    },
                },
            });

            await prisma.installmentLedger.create({
                data: {
                    order_id: order.id,
                    delivery_id: delivery.id,
                    token: `TOKEN-${c.orderRef}`,
                    short_id: `L-${c.orderRef}`,
                    ledger_rows: c.ledgerRows,
                },
            });

            console.log(`Seeded: ${c.orderRef} (${c.name}) -> ${c.explanation}`);
        }

        console.log('\nDone. All 5 demo accounts are assigned to recovery officer "sarwar rec".');
    } catch (error) {
        console.error('Error during seeding:', error);
    } finally {
        await prisma.$disconnect();
    }
}

seed();