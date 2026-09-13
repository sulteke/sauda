-- Location-aware approval: a boutique can be APPROVED for the website without
-- being Telegram-eligible (non-Almaty), and we store its detected region/country
-- alongside the existing city. Purely additive — no boutique is ever removed or
-- re-imported because of its location.

-- New lifecycle value (safe to add: not referenced by any statement in this tx).
ALTER TYPE "BoutiqueStatus" ADD VALUE IF NOT EXISTS 'APPROVED';

-- Detected location columns (city already exists).
ALTER TABLE "boutiques" ADD COLUMN "region" TEXT;
ALTER TABLE "boutiques" ADD COLUMN "country" TEXT;
