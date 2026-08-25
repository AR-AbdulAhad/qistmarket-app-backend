-- Links a Complaint to the actual Order it belongs to, once a CSR confirms
-- the match. Nullable and unbackfilled — existing complaints simply stay
-- unlinked (order_id = NULL) until a CSR links them from the complaint
-- detail view.

ALTER TABLE `complaints` ADD COLUMN `order_id` INT NULL AFTER `media_urls`;

CREATE INDEX `complaints_order_id_idx` ON `complaints`(`order_id`);

ALTER TABLE `complaints` ADD CONSTRAINT `complaints_order_id_fkey`
  FOREIGN KEY (`order_id`) REFERENCES `Order`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
