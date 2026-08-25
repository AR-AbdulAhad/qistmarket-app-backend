-- This migration originally failed in production (2026-04-13) because it
-- targeted a table named `orders` instead of the actual table `Order`. The
-- column it was meant to add, `postponed_feedback`, already exists on the
-- live `Order` table (added out-of-band), so this file is a no-op placeholder
-- that lets `prisma migrate resolve --applied` mark the historical failed
-- entry as resolved without re-running anything.
SELECT 1;
