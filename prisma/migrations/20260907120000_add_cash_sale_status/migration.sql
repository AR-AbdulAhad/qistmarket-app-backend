-- Cash Sale "Cancel Invoice" support: cancelling a sale used to hard-delete
-- its row(s) from `cash_sales`, losing the record entirely. It now flips
-- `status` to 'cancelled' instead, so the transaction stays visible in Cash
-- Sale History (and in any report/audit trail built on it) with its outcome
-- clearly marked, exactly like Order.status/cancelled_at already do.

ALTER TABLE `cash_sales`
  ADD COLUMN `status` VARCHAR(16) NOT NULL DEFAULT 'active' AFTER `sale_group`,
  ADD COLUMN `cancelled_at` DATETIME(3) NULL AFTER `status`,
  ADD COLUMN `cancelled_reason` TEXT NULL AFTER `cancelled_at`;

CREATE INDEX `cash_sales_status_idx` ON `cash_sales`(`status`);
