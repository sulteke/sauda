-- Requests actually sent to an AI provider, per project + model, per quota day.
-- Additive only: creates one new table, touches nothing that already exists.
CREATE TABLE "ai_request_ledger" (
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_request_ledger_pkey" PRIMARY KEY ("provider","model","day")
);
