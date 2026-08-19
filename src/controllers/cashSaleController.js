const prisma = require('../../lib/prisma');
const { logAction } = require('../utils/auditLogger');
const { updateCashRegister } = require('../utils/cashRegisterUtils');

const now = () => new Date();

// "Available to sell" is defined identically to the outlet Stock List page
// (getInventory in inventoryController.js: status not 'Used Stock' + not
// is_used) — the Cash Sale product picker reuses that same /api/outlet/inventory
// endpoint directly rather than a separate one, so this predicate only needs
// to exist here as the server-side guard at actual sale time.
const isSellable = (item) => item.status === 'In Stock' && !item.is_used;

/**
 * POST /api/outlet/cash-sale
 * Confirms a walk-in cash sale: marks the stock item Sold and records the
 * sale. Feeds the outlet's Cash Register the same way other cash-generating
 * actions do (updateCashRegister).
 */
const createCashSale = async (req, res) => {
  const outlet_id = req.user.outlet_id;
  if (!outlet_id) {
    return res.status(403).json({ success: false, message: 'Not an outlet user.' });
  }

  const { inventory_id, customer_name, customer_phone, customer_cnic, quoted_price, final_price } = req.body;

  if (!inventory_id) {
    return res.status(400).json({ success: false, message: 'inventory_id is required' });
  }
  if (!customer_name || !customer_name.trim()) {
    return res.status(400).json({ success: false, message: 'Customer name is required' });
  }
  const finalPriceNum = parseFloat(final_price);
  if (!(finalPriceNum > 0)) {
    return res.status(400).json({ success: false, message: 'A valid final price is required' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Row-level guard against double-selling the same unit (e.g. two
      // outlet staff confirming the same item at once) — the WHERE clause
      // requires it to still be sellable at update time, not just at the
      // moment the dropdown was loaded.
      const inventory = await tx.outletInventory.findFirst({
        where: { id: parseInt(inventory_id), outlet_id },
      });

      if (!inventory || !isSellable(inventory)) {
        const err = new Error('This item is no longer available for sale (already sold, out of stock, or not eligible).');
        err.statusCode = 409;
        throw err;
      }

      const updated = await tx.outletInventory.updateMany({
        where: { id: inventory.id, status: 'In Stock', is_used: false },
        data: { status: 'Sold', updated_at: now() },
      });
      if (updated.count === 0) {
        const err = new Error('This item was just sold by someone else. Please refresh and try again.');
        err.statusCode = 409;
        throw err;
      }

      const sale = await tx.cashSale.create({
        data: {
          outlet_id,
          inventory_id: inventory.id,
          product_name: inventory.product_name,
          category: inventory.category,
          imei_serial: inventory.imei_serial,
          color_variant: inventory.color_variant,
          customer_name: customer_name.trim(),
          customer_phone: customer_phone ? String(customer_phone).trim() : null,
          customer_cnic: customer_cnic ? String(customer_cnic).trim() : null,
          quoted_price: parseFloat(quoted_price) || finalPriceNum,
          final_price: finalPriceNum,
          sold_by_user_id: req.user.id,
          created_at: now(),
          updated_at: now(),
        },
      });

      await updateCashRegister(tx, outlet_id, 'cash_sale', finalPriceNum, 'add');

      return sale;
    });

    await logAction(
      req,
      'CASH_SALE_CREATED',
      `Cash sale: ${result.product_name} (${result.imei_serial || 'N/A'}) sold to ${result.customer_name} for PKR ${finalPriceNum}`,
      result.id,
      'CashSale'
    );

    return res.status(201).json({ success: true, message: 'Sale completed successfully', data: { sale: result } });
  } catch (error) {
    if (error.statusCode === 409) {
      return res.status(409).json({ success: false, message: error.message });
    }
    console.error('createCashSale error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * GET /api/outlet/cash-sale/history?page=&limit=&search=
 * Paginated Cash Sale history for the outlet.
 */
const getCashSaleHistory = async (req, res) => {
  const outlet_id = req.user.outlet_id;
  if (!outlet_id) {
    return res.status(403).json({ success: false, message: 'Not an outlet user.' });
  }

  const { page = 1, limit = 10, search = '' } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    const where = { outlet_id };
    if (search.trim()) {
      where.OR = [
        { customer_name: { contains: search.trim() } },
        { product_name: { contains: search.trim() } },
        { imei_serial: { contains: search.trim() } },
        { customer_phone: { contains: search.trim() } },
      ];
    }

    const [sales, total] = await Promise.all([
      prisma.cashSale.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
        include: { sold_by: { select: { username: true, full_name: true } } },
      }),
      prisma.cashSale.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        sales,
        pagination: {
          page: Number(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNext: skip + take < total,
          hasPrev: Number(page) > 1,
        },
      },
    });
  } catch (error) {
    console.error('getCashSaleHistory error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  createCashSale,
  getCashSaleHistory,
};
