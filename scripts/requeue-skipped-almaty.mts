/**
 * Puts approved Almaty boutiques that the publisher skipped back in the queue.
 *
 * The publisher skips a boutique whose city it cannot place, and until the
 * city backfill most boutiques had no city at all — so approved Almaty stores
 * were marked SKIPPED and never posted. Their city is known now, but SKIPPED is
 * final to Publish Queue, which only takes PENDING. This moves exactly those
 * back.
 *
 *   DATABASE_URL=... npx tsx scripts/requeue-skipped-almaty.mts           # dry run
 *   DATABASE_URL=... npx tsx scripts/requeue-skipped-almaty.mts --write   # apply
 *
 * Dry run by default. It only requeues — nothing is posted by running it. The
 * daily publication limit then decides how many go out per day.
 *
 * Narrow on purpose: only APPROVED, only SKIPPED, only a city that is now
 * Almaty, and only boutiques that have never been published. A boutique
 * skipped for being in another city stays skipped.
 */
import { PrismaClient } from "@prisma/client";

import { isAlmaty } from "../src/lib/location.ts";

const url = process.env.DATABASE_URL ?? "";
if (!url) throw new Error("DATABASE_URL is required.");
const write = process.argv.includes("--write");
/**
 * Handles to hold back, e.g. --exclude=tommyhilfiger,calzedonia. They stay
 * SKIPPED and approved, untouched — for a decision this script should not make.
 */
const exclude = new Set(
  (process.argv.find((a) => a.startsWith("--exclude="))?.slice("--exclude=".length) ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

const prisma = new PrismaClient({ datasources: { db: { url } } });

const skipped = await prisma.boutique.findMany({
  where: { status: "APPROVED", telegramStatus: "SKIPPED", telegramPublishedAt: null },
  select: { id: true, instagramHandle: true, city: true },
  orderBy: { followersCount: "desc" },
});
const almaty = skipped.filter((b) => isAlmaty(b.city));
const held = almaty.filter((b) => exclude.has((b.instagramHandle ?? "").toLowerCase()));
const eligible = almaty.filter((b) => !exclude.has((b.instagramHandle ?? "").toLowerCase()));

console.log(`\n${write ? "WRITING" : "DRY RUN — nothing written"}`);
console.log(`  approved + skipped + never published : ${skipped.length}`);
console.log(`  of those, now Almaty                 : ${almaty.length}`);
console.log(`    held back by --exclude             : ${held.length}`);
console.log(`    will requeue                       : ${eligible.length}`);
console.log(`  staying skipped (not Almaty)         : ${skipped.length - almaty.length}\n`);
for (const b of held) console.log(`  held: @${b.instagramHandle}`);
for (const b of eligible) console.log(`  @${b.instagramHandle}`);

if (write) {
  let moved = 0;
  for (const b of eligible) {
    // Conditional on still being SKIPPED, so a boutique published or changed in
    // the meantime is left alone.
    const r = await prisma.boutique.updateMany({
      where: { id: b.id, telegramStatus: "SKIPPED" },
      data: { telegramStatus: "PENDING", telegramError: null },
    });
    moved += r.count;
  }
  console.log(`\n  requeued: ${moved}`);
}

await prisma.$disconnect();
