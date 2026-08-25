-- Adds walk-in/outright cash-sale support: a new `cash_sales` table (one row
-- per sale against existing outlet stock) and a `cash_sale` running total
-- column on `CashRegister` so it feeds the outlet's daily cash formula the
-- same way Down Payments / Installments Received etc. already do.

CREATE TABLE `cash_sales` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `outlet_id` INT NOT NULL,
  `inventory_id` INT NOT NULL,
  `product_name` VARCHAR(191) NOT NULL,
  `category` VARCHAR(191) NULL,
  `imei_serial` VARCHAR(191) NULL,
  `color_variant` VARCHAR(191) NULL,
  `customer_name` VARCHAR(191) NOT NULL,
  `customer_phone` VARCHAR(191) NULL,
  `customer_cnic` VARCHAR(191) NULL,
  `quoted_price` DOUBLE NOT NULL,
  `final_price` DOUBLE NOT NULL,
  `sold_by_user_id` INT NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `cash_sales_outlet_id_idx` (`outlet_id`),
  INDEX `cash_sales_created_at_idx` (`created_at`),
  CONSTRAINT `cash_sales_outlet_id_fkey` FOREIGN KEY (`outlet_id`) REFERENCES `outlets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `cash_sales_inventory_id_fkey` FOREIGN KEY (`inventory_id`) REFERENCES `outlet_inventories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `cash_sales_sold_by_user_id_fkey` FOREIGN KEY (`sold_by_user_id`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `cash_registers` ADD COLUMN `cash_sale` DOUBLE NOT NULL DEFAULT 0 AFTER `vendor_receipts`;
