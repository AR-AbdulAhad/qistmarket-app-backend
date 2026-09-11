-- Branch/outlet phone number, captured on the branch profile and shown on
-- that branch's customer-facing ledgers (Branch Details block) instead of
-- always falling back to the global support number. Nullable and
-- unbackfilled — existing branches simply show the global number until
-- someone fills theirs in.

ALTER TABLE `outlets` ADD COLUMN `phone` VARCHAR(191) NULL AFTER `address`;
