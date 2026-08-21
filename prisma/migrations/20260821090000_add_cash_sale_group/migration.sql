-- Adds multi-product Cash Sale support: `sale_group` ties together several
-- `cash_sales` rows (one per product) that were checked out together in a
-- single walk-in transaction, so they can be shown/edited/cancelled as one
-- receipt. Nullable and unbackfilled — existing single-product sales simply
-- stay ungrouped (sale_group = NULL), which the app already treats as "one
-- item, no group" identically to how it behaved before this column existed.

ALTER TABLE `cash_sales` ADD COLUMN `sale_group` VARCHAR(64) NULL AFTER `sold_by_user_id`;

CREATE INDEX `cash_sales_sale_group_idx` ON `cash_sales`(`sale_group`);
