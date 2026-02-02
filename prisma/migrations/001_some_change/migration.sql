-- AlterTable
ALTER TABLE `GrantorVerification` ADD COLUMN `nearest_location` VARCHAR(191) NOT NULL;

-- AlterTable
ALTER TABLE `PurchaserVerification` ADD COLUMN `nearest_location` VARCHAR(191) NOT NULL;

-- DropTable
DROP TABLE `links`;

