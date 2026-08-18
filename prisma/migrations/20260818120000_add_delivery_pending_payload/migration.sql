-- Adds a nullable JSON payload column on `Delivery` used to persist the
-- request data needed to finish a delivery once a gated PayTrigger device
-- enrollment is confirmed via webhook. Existing rows are unaffected (NULL).
ALTER TABLE `Delivery` ADD COLUMN `pending_payload` LONGTEXT NULL;
