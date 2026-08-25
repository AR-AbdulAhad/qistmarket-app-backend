const crypto = require('crypto');
const prisma = require('../../lib/prisma');
const { logAction } = require('../utils/auditLogger');
const { updateCashRegister } = require('../utils/cashRegisterUtils');
const { notifyCashSale } = require('../services/customerNotificationService');

const now = () => new Date();

// Edit/Delete are only allowed within 3 days of the sale's creation — same
// governance rule as Expense Vouchers (expenseController.js) so every
// financial record in the outlet portal follows one consistent policy.
const EDIT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const isWithinEditWindow = (sale) => (now() - new Date(sale.created_at)) <= EDIT_WINDOW_MS;

// "Available to sell" is defined identically to the outlet Stock List page
// (getInventory in inventoryController.js: status not 'Used Stock' + not
// is_used) — the Cash Sale product picker reuses that same /api/outlet/inventory
// endpoint directly rather than a separate one, so this predicate only needs
// to exist here as the server-side guard at actual sale time.
const isSellable = (item) => item.status === 'In Stock' && !item.is_used;

// A "sale" in the API/UI sense can be several `cash_sales` rows sharing one
// `sale_group` (a multi-product cart checked out together) — everywhere
// below works with the group as a unit rather than a single row.
const groupTotal = (rows) => rows.reduce((s, r) => s + r.final_price, 0);
const groupQuotedTotal = (rows) => rows.reduce((s, r) => s + r.quoted_price, 0);

/**
 * POST /api/outlet/cash-sale
 * Confirms a walk-in cash sale for one or more products in a single cart
 * checkout. Marks every stock item Sold and records one CashSale row per
 * product (linked by `sale_group` when there's more than one), feeding the
 * outlet's Cash Register the same way other cash-generating actions do.
 */
const createCashSale = async (req, res) => {
  const outlet_id = req.user.outlet_id;
  if (!outlet_id) {
    return res.status(403).json({ success: false, message: 'Not an outlet user.' });
  }

  const { customer_name, customer_phone, customer_cnic, items } = req.body;

  if (!customer_name || !customer_name.trim()) {
    return res.status(400).json({ success: false, message: 'Customer name is required' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'At least one product is required' });
  }
  for (const it of items) {
    if (!it.inventory_id) {
      return res.status(400).json({ success: false, message: 'Every item must have a product selected' });
    }
    if (!(parseFloat(it.final_price) > 0)) {
      return res.status(400).json({ success: false, message: 'Every item needs a valid final price' });
    }
  }

  try {
    const saleGroup = items.length > 1 ? crypto.randomUUID() : null;

    const createdSales = await prisma.$transaction(async (tx) => {
      const rows = [];
      for (const it of items) {
        // Row-level guard against double-selling the same unit (e.g. two
        // outlet staff confirming the same item at once) — the WHERE clause
        // requires it to still be sellable at update time, not just at the
        // moment the dropdown was loaded.
        const inventory = await tx.outletInventory.findFirst({
          where: { id: parseInt(it.inventory_id), outlet_id },
        });

        if (!inventory || !isSellable(inventory)) {
          const err = new Error(`"${inventory?.product_name || 'One of the selected items'}" is no longer available for sale (already sold, out of stock, or not eligible).`);
          err.statusCode = 409;
          throw err;
        }

        const updated = await tx.outletInventory.updateMany({
          where: { id: inventory.id, status: 'In Stock', is_used: false },
          data: { status: 'Sold', updated_at: now() },
        });
        if (updated.count === 0) {
          const err = new Error(`"${inventory.product_name}" was just sold by someone else. Please refresh and try again.`);
          err.statusCode = 409;
          throw err;
        }

        const finalPriceNum = parseFloat(it.final_price);
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
            quoted_price: parseFloat(it.quoted_price) || finalPriceNum,
            final_price: finalPriceNum,
            sold_by_user_id: req.user.id,
            sale_group: saleGroup,
            created_at: now(),
            updated_at: now(),
          },
        });
        rows.push(sale);
      }

      await updateCashRegister(tx, outlet_id, 'cash_sale', groupTotal(rows), 'add');

      return rows;
    });

    const total = groupTotal(createdSales);

    await logAction(
      req,
      'CASH_SALE_CREATED',
      `Cash sale: ${createdSales.length} item(s) sold to ${createdSales[0].customer_name} for PKR ${total}`,
      createdSales[0].id,
      'CashSale'
    );

    // Fire-and-forget: notifyCashSale fails soft (never throws) and must not
    // delay or block the sale response.
    notifyCashSale(createdSales, outlet_id, { full_name: req.user.full_name, phone: req.user.phone });

    return res.status(201).json({
      success: true,
      message: 'Sale completed successfully',
      data: { sale: createdSales[0], items: createdSales, sale_group: saleGroup },
    });
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
 * Paginated Cash Sale history for the outlet — one row per transaction
 * (multi-product carts are collapsed into a single grouped row here; the
 * product column and invoice page expand out the individual items).
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

    // Grouping by nullable sale_group has to happen in JS — Prisma can't
    // treat "several rows sharing a group" and "one ungrouped row" uniformly
    // in a single groupBy. Outlet cash-sale volume is modest enough that
    // fetching the full filtered set before paginating is fine.
    const rows = await prisma.cashSale.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: { sold_by: { select: { username: true, full_name: true } } },
    });

    const seenGroups = new Set();
    const transactions = [];
    for (const row of rows) {
      if (row.sale_group) {
        if (seenGroups.has(row.sale_group)) continue;
        seenGroups.add(row.sale_group);
        const siblings = rows.filter((r) => r.sale_group === row.sale_group);
        transactions.push({
          id: row.id,
          sale_group: row.sale_group,
          item_count: siblings.length,
          product_name: siblings.length > 1 ? `${siblings[0].product_name} +${siblings.length - 1} more` : siblings[0].product_name,
          imei_serial: siblings.length === 1 ? siblings[0].imei_serial : null,
          customer_name: row.customer_name,
          customer_phone: row.customer_phone,
          customer_cnic: row.customer_cnic,
          final_price: groupTotal(siblings),
          created_at: row.created_at,
          sold_by: row.sold_by,
        });
      } else {
        transactions.push({
          id: row.id,
          sale_group: null,
          item_count: 1,
          product_name: row.product_name,
          imei_serial: row.imei_serial,
          customer_name: row.customer_name,
          customer_phone: row.customer_phone,
          customer_cnic: row.customer_cnic,
          final_price: row.final_price,
          created_at: row.created_at,
          sold_by: row.sold_by,
        });
      }
    }

    const total = transactions.length;
    const paginated = transactions.slice(skip, skip + take);

    return res.status(200).json({
      success: true,
      data: {
        sales: paginated,
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

/**
 * GET /api/outlet/cash-sale/:id
 * A single transaction — one product, or the full cart if `id` belongs to a
 * multi-product sale_group. Used by the print/download invoice page and the
 * edit form. `sale` carries transaction-level totals; `items` is always the
 * per-product breakdown (length 1 for a single-product sale).
 */
const getCashSaleById = async (req, res) => {
  const { id } = req.params;
  const outlet_id = req.user.outlet_id;
  if (!outlet_id) {
    return res.status(403).json({ success: false, message: 'Not an outlet user.' });
  }

  try {
    const row = await prisma.cashSale.findUnique({
      where: { id: parseInt(id) },
      include: {
        sold_by: { select: { username: true, full_name: true } },
        outlet: { select: { name: true, address: true } },
      },
    });

    if (!row || row.outlet_id !== outlet_id) {
      return res.status(404).json({ success: false, message: 'Sale not found' });
    }

    let items = [row];
    if (row.sale_group) {
      items = await prisma.cashSale.findMany({
        where: { sale_group: row.sale_group, outlet_id },
        orderBy: { id: 'asc' },
      });
    }

    const sale = {
      ...row,
      final_price: groupTotal(items),
      quoted_price: groupQuotedTotal(items),
      item_count: items.length,
    };

    return res.status(200).json({ success: true, data: { sale, items } });
  } catch (error) {
    console.error('getCashSaleById error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * PUT /api/outlet/cash-sale/:id
 * Edits a transaction — customer details and/or its entire product line-up.
 * Passing `items` replaces the whole cart (whether it was one product or
 * several before): every currently-linked unit is released back to stock,
 * every newly-listed unit is claimed, old rows are deleted and new ones
 * created under a (possibly new) sale_group. Any change in the transaction
 * total is reconciled against the Cash Register the same way create/delete do.
 */
const updateCashSale = async (req, res) => {
  const { id } = req.params;
  const outlet_id = req.user.outlet_id;
  if (!outlet_id) {
    return res.status(403).json({ success: false, message: 'Not an outlet user.' });
  }

  const { customer_name, customer_phone, customer_cnic, items } = req.body;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const row = await tx.cashSale.findUnique({ where: { id: parseInt(id) } });
      if (!row || row.outlet_id !== outlet_id) {
        const err = new Error('Sale not found');
        err.statusCode = 404;
        throw err;
      }
      if (!isWithinEditWindow(row)) {
        const err = new Error('EDIT_WINDOW_EXPIRED');
        throw err;
      }

      const existingRows = row.sale_group
        ? await tx.cashSale.findMany({ where: { sale_group: row.sale_group, outlet_id } })
        : [row];
      const oldTotal = groupTotal(existingRows);

      const customerData = {};
      if (customer_name !== undefined) {
        if (!customer_name.trim()) {
          const err = new Error('Customer name is required');
          err.statusCode = 400;
          throw err;
        }
        customerData.customer_name = customer_name.trim();
      }
      if (customer_phone !== undefined) customerData.customer_phone = customer_phone ? String(customer_phone).trim() : null;
      if (customer_cnic !== undefined) customerData.customer_cnic = customer_cnic ? String(customer_cnic).trim() : null;

      let finalRows;

      if (Array.isArray(items)) {
        if (items.length === 0) {
          const err = new Error('At least one product is required');
          err.statusCode = 400;
          throw err;
        }
        for (const it of items) {
          if (!it.inventory_id) {
            const err = new Error('Every item must have a product selected');
            err.statusCode = 400;
            throw err;
          }
          if (!(parseFloat(it.final_price) > 0)) {
            const err = new Error('Every item needs a valid final price');
            err.statusCode = 400;
            throw err;
          }
        }

        const existingInventoryIds = new Set(existingRows.map((r) => r.inventory_id));
        const newInventoryIds = items.map((it) => parseInt(it.inventory_id));

        // Claim every requested unit that isn't already part of this same
        // transaction (those are just being kept, not re-claimed).
        for (const invId of newInventoryIds) {
          if (existingInventoryIds.has(invId)) continue;
          const newItem = await tx.outletInventory.findFirst({ where: { id: invId, outlet_id } });
          if (!newItem || !isSellable(newItem)) {
            const err = new Error(`"${newItem?.product_name || 'One of the selected items'}" is no longer available for sale (already sold, out of stock, or not eligible).`);
            err.statusCode = 409;
            throw err;
          }
          const claimed = await tx.outletInventory.updateMany({
            where: { id: newItem.id, status: 'In Stock', is_used: false },
            data: { status: 'Sold', updated_at: now() },
          });
          if (claimed.count === 0) {
            const err = new Error(`"${newItem.product_name}" was just sold by someone else. Please refresh and try again.`);
            err.statusCode = 409;
            throw err;
          }
        }

        // Release every previously-linked unit that's no longer in the cart.
        const keptInventoryIds = new Set(newInventoryIds);
        for (const oldRow of existingRows) {
          if (keptInventoryIds.has(oldRow.inventory_id)) continue;
          await tx.outletInventory.updateMany({
            where: { id: oldRow.inventory_id, status: 'Sold' },
            data: { status: 'In Stock', updated_at: now() },
          });
        }

        await tx.cashSale.deleteMany({ where: { id: { in: existingRows.map((r) => r.id) } } });

        const newSaleGroup = items.length > 1 ? (row.sale_group || crypto.randomUUID()) : null;
        finalRows = [];
        for (const it of items) {
          const invId = parseInt(it.inventory_id);
          const inventory = await tx.outletInventory.findUnique({ where: { id: invId } });
          const finalPriceNum = parseFloat(it.final_price);
          const created = await tx.cashSale.create({
            data: {
              outlet_id,
              inventory_id: invId,
              product_name: inventory.product_name,
              category: inventory.category,
              imei_serial: inventory.imei_serial,
              color_variant: inventory.color_variant,
              customer_name: customerData.customer_name ?? row.customer_name,
              customer_phone: customerData.customer_phone !== undefined ? customerData.customer_phone : row.customer_phone,
              customer_cnic: customerData.customer_cnic !== undefined ? customerData.customer_cnic : row.customer_cnic,
              quoted_price: parseFloat(it.quoted_price) || finalPriceNum,
              final_price: finalPriceNum,
              sold_by_user_id: row.sold_by_user_id,
              sale_group: newSaleGroup,
              created_at: row.created_at,
              updated_at: now(),
            },
          });
          finalRows.push(created);
        }
      } else {
        // No product changes — just update the existing row(s) in place
        // (customer details apply to every row in the group identically).
        if (Object.keys(customerData).length > 0) {
          await tx.cashSale.updateMany({
            where: { id: { in: existingRows.map((r) => r.id) } },
            data: { ...customerData, updated_at: now() },
          });
        }
        finalRows = await tx.cashSale.findMany({ where: { id: { in: existingRows.map((r) => r.id) } } });
      }

      const newTotal = groupTotal(finalRows);
      const delta = newTotal - oldTotal;
      if (delta !== 0) {
        await updateCashRegister(tx, outlet_id, 'cash_sale', Math.abs(delta), delta > 0 ? 'add' : 'subtract');
      }

      return finalRows;
    });

    await logAction(
      req,
      'CASH_SALE_UPDATED',
      `Cash sale #${result[0].id} (${result.length} item(s)) updated for ${result[0].customer_name}`,
      result[0].id,
      'CashSale'
    );

    return res.status(200).json({ success: true, message: 'Sale updated successfully', data: { sale: result[0], items: result } });
  } catch (error) {
    if (error.message === 'EDIT_WINDOW_EXPIRED') {
      return res.status(403).json({ success: false, message: 'This sale is more than 3 days old and can no longer be edited.' });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error('updateCashSale error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * DELETE /api/outlet/cash-sale/:id
 * Cancels an entire transaction (every product in its cart, if it was a
 * multi-product sale): reverses the Cash Register impact, restores every
 * unit to sellable stock, and removes the record(s). Mirrors
 * deleteExpenseVoucher's pattern (expenseController.js) for consistency
 * across the outlet portal.
 */
const deleteCashSale = async (req, res) => {
  const { id } = req.params;
  const outlet_id = req.user.outlet_id;
  if (!outlet_id) {
    return res.status(403).json({ success: false, message: 'Not an outlet user.' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const row = await tx.cashSale.findUnique({ where: { id: parseInt(id) } });
      if (!row || row.outlet_id !== outlet_id) {
        const err = new Error('Sale not found');
        err.statusCode = 404;
        throw err;
      }
      if (!isWithinEditWindow(row)) {
        const err = new Error('EDIT_WINDOW_EXPIRED');
        throw err;
      }

      const rows = row.sale_group
        ? await tx.cashSale.findMany({ where: { sale_group: row.sale_group, outlet_id } })
        : [row];

      await tx.cashSale.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });

      // Restore every unit to sellable stock — only if it's still marked Sold
      // (defensive: avoids re-listing a unit that was independently moved on
      // since the sale, e.g. flagged as damaged/used).
      for (const r of rows) {
        await tx.outletInventory.updateMany({
          where: { id: r.inventory_id, status: 'Sold' },
          data: { status: 'In Stock', updated_at: now() },
        });
      }

      await updateCashRegister(tx, outlet_id, 'cash_sale', groupTotal(rows), 'subtract');

      return rows;
    });

    await logAction(
      req,
      'CASH_SALE_DELETED',
      `Cash sale #${result[0].id}: ${result.length} item(s) (PKR ${groupTotal(result)}) sold to ${result[0].customer_name} was cancelled.`,
      result[0].id,
      'CashSale'
    );

    return res.status(200).json({ success: true, message: 'Sale cancelled successfully.' });
  } catch (error) {
    if (error.message === 'EDIT_WINDOW_EXPIRED') {
      return res.status(403).json({ success: false, message: 'This sale is more than 3 days old and can no longer be cancelled.' });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error('deleteCashSale error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  createCashSale,
  getCashSaleHistory,
  getCashSaleById,
  updateCashSale,
  deleteCashSale,
};
