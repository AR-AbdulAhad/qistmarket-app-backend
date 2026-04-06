const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Centrally updates the physical Cash Register (Daybook) for an outlet.
 * Maintains the exact cash inflows/outflows for a given day.
 * 
 * @param {object} tx - Prisma transaction context. If not provided, uses `prisma`.
 * @param {number} outletId - The ID of the outlet.
 * @param {string} field - The specific field of CashRegister being impacted:
 *  - 'down_payments' (e.g. from cash_in_hand / Delivery)
 *  - 'installments_received' (e.g. order monthly payments)
 *  - 'cash_from_recovery' (overall sum of recoveries or specific installments)
 *  - 'cash_from_delivery' (total cash brought in by delivery rider)
 *  - 'expenses' (Expense Vouchers)
 *  - 'vendor_payments' (Vendor Payments)
 * @param {number} amount - The amount to log.
 * @param {string} operation - 'add' or 'subtract'. 'add' implies money coming IN. 'subtract' implies going OUT.
 */
const updateCashRegister = async (tx, outletId, field, amount, operation) => {
    const db = tx || prisma;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Ensure the register exists for today, else find yesterday's closing
    let register = await db.cashRegister.findUnique({
        where: {
            outlet_id_date: { outlet_id: outletId, date: today }
        }
    });

    if (!register) {
        // Find latest register before today
        const lastRegister = await db.cashRegister.findFirst({
            where: { outlet_id: outletId, date: { lt: today } },
            orderBy: { date: 'desc' }
        });
        
        let opening = lastRegister ? lastRegister.closing_cash : 0;
        register = await db.cashRegister.create({
            data: {
                outlet_id: outletId,
                date: today,
                opening_cash: opening,
                closing_cash: opening
            }
        });
    }

    // Determine math
    const val = parseFloat(amount);
    const validFields = ['down_payments', 'installments_received', 'cash_from_recovery', 'cash_from_delivery', 'expenses', 'vendor_payments'];
    
    if (!validFields.includes(field)) {
        throw new Error(`Invalid CashRegister field: ${field}`);
    }

    // Determine impact on closing_cash.
    // Inflows (add to closing cash)
    const inflows = ['down_payments', 'installments_received', 'cash_from_recovery', 'cash_from_delivery'];
    // Outflows (subtract from closing cash)
    const outflows = ['expenses', 'vendor_payments'];

    let newFieldTotal = register[field];
    let newClosingCash = register.closing_cash;

    // Regardless of inflow/outflow, if the operation is 'add', it increases that specific record's total.
    // E.g., adding an expense -> operation='add' to 'expenses' -> newFieldTotal += val.
    // E.g., refunding an expense -> operation='subtract' from 'expenses' -> newFieldTotal -= val.

    if (operation === 'add') {
        newFieldTotal += val;
        
        if (inflows.includes(field)) {
            newClosingCash += val; // adding an inflow = more cash
        } else if (outflows.includes(field)) {
            newClosingCash -= val; // adding an outflow = less cash
        }
    } else if (operation === 'subtract') {
        newFieldTotal -= val;

        if (inflows.includes(field)) {
            newClosingCash -= val; // withdrawing an inflow = less cash
        } else if (outflows.includes(field)) {
            newClosingCash += val; // reversing an outflow = more cash
        }
    } else {
        throw new Error(`Invalid operation: ${operation}`);
    }

    // Save
    const updated = await db.cashRegister.update({
        where: { id: register.id },
        data: {
            [field]: newFieldTotal,
            closing_cash: newClosingCash
        }
    });

    return updated;
};

module.exports = {
    updateCashRegister
};
