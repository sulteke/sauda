/**
 * Puts the LOCAL queue back to PENDING_ANALYSIS and clears provider cooldowns,
 * so "Process Queue" can be pressed again.
 *
 *   npx tsx scripts/reset-local-queue.mts          # recover from failures
 *   npx tsx scripts/reset-local-queue.mts --rerun  # also re-analyze reviewed items
 *
 * DATABASE_URL must point at the local database and is checked before anything
 * is opened — this script writes, and production Supabase must never be the
 * thing it writes to.
 */
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
if (!/127\.0\.0\.1|localhost/.test(url)) throw new Error("REFUSING: DATABASE_URL is not local");

/**
 * Whether to pull already-reviewed items back for another pass.
 *
 * Off by default: undoing a review is not a recovery step, it is a deliberate
 * "let me watch that run again". Failures are requeued either way.
 */
const rerun = process.argv.includes("--rerun");

const prisma = new PrismaClient({ datasources: { db: { url } } });

const statuses = rerun
  ? (["ANALYSIS_FAILED", "ANALYZING", "READY_FOR_REVIEW"] as const)
  : (["ANALYSIS_FAILED", "ANALYZING"] as const);

const requeued = await prisma.importQueue.updateMany({
  where: { status: { in: [...statuses] } },
  data: { status: "PENDING_ANALYSIS", error: null },
});
const cleared = await prisma.aiProviderCooldown.deleteMany({});
await prisma.importJob.updateMany({
  where: { status: "FAILED" },
  data: { status: "PENDING", error: null },
});

// A re-run must be a real re-analysis: analyzedAt/analyzedBy are the record of a
// SUCCESSFUL analysis, so leaving yesterday's stamp on a requeued item would
// misreport both the daily count and which provider produced the answer.
if (rerun) {
  const unstamped = await prisma.importJob.updateMany({
    where: { analyzedAt: { not: null } },
    data: { analyzedAt: null, analyzedBy: null },
  });
  console.log(`  analysis stamps cleared      : ${unstamped.count}`);
}

console.log(`  requeued to PENDING_ANALYSIS : ${requeued.count}${rerun ? " (incl. reviewed)" : ""}`);
console.log(`  provider cooldowns cleared   : ${cleared.count}`);
const pending = await prisma.importQueue.count({ where: { status: "PENDING_ANALYSIS" } });
console.log(`  ready to analyze             : ${pending}`);
await prisma.$disconnect();
