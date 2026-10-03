/**
 * Fills the empty city of existing boutiques from data the pipeline already
 * holds: the 2GIS venue they were discovered in, and the AI's analysis.
 *
 * The import fix makes NEW imports write these; this catches the boutiques
 * created before it. It uses the same resolveLocation the import uses, so a
 * backfilled row is indistinguishable from a freshly imported one.
 *
 *   DATABASE_URL=... npx tsx scripts/backfill-boutique-city.mts           # dry run
 *   DATABASE_URL=... npx tsx scripts/backfill-boutique-city.mts --write   # apply
 *
 * Dry run by default — it writes nothing unless --write is passed.
 *
 * It only ever FILLS an empty city, and each write is conditional on the
 * column still being empty, so a city set by hand is never replaced. It does
 * not touch telegramStatus: nothing is published or re-queued by running it.
 */
import { PrismaClient } from "@prisma/client";

import { cityFromGisUrl, resolveLocation } from "../src/lib/location.ts";

const url = process.env.DATABASE_URL ?? "";
if (!url) throw new Error("DATABASE_URL is required.");
const write = process.argv.includes("--write");

const prisma = new PrismaClient({ datasources: { db: { url } } });

const empty = await prisma.boutique.findMany({
  where: { city: null },
  select: { id: true, instagramHandle: true, aiResult: true, status: true, telegramStatus: true },
});

const gis = await prisma.discoveryCandidate.findMany({
  where: { source: "2gis" },
  select: { handle: true, sourceMeta: true },
  orderBy: { createdAt: "desc" },
});
const gisCityByHandle = new Map<string, string>();
for (const c of gis) {
  const key = c.handle.toLowerCase();
  if (gisCityByHandle.has(key)) continue;
  const city = cityFromGisUrl((c.sourceMeta as { gisUrl?: string | null } | null)?.gisUrl);
  if (city) gisCityByHandle.set(key, city);
}

type Plan = { id: string; handle: string; city: string; from: string; status: string; tg: string };
const plan: Plan[] = [];
for (const b of empty) {
  const handle = b.instagramHandle ?? "";
  const gisCity = gisCityByHandle.get(handle.toLowerCase()) ?? null;
  const aiCity = (b.aiResult as { city?: string | null } | null)?.city ?? null;
  const resolved = resolveLocation({ gisCity, aiCity });
  if (!resolved.city) continue;
  plan.push({
    id: b.id,
    handle,
    city: resolved.city,
    from: gisCity ? "2gis" : "ai",
    status: b.status,
    tg: b.telegramStatus,
  });
}

const byCity = new Map<string, number>();
for (const p of plan) byCity.set(p.city, (byCity.get(p.city) ?? 0) + 1);

console.log(`\n${write ? "WRITING" : "DRY RUN — nothing written"}`);
console.log(`  boutiques with an empty city : ${empty.length}`);
console.log(`  of those, a city is known    : ${plan.length}`);
for (const [city, n] of [...byCity].sort((a, b) => b[1] - a[1])) console.log(`    ${city.padEnd(14)} ${n}`);
console.log(`  still unknown afterwards     : ${empty.length - plan.length}\n`);
for (const p of plan) {
  console.log(`  @${p.handle.padEnd(28)} → ${p.city.padEnd(10)} (${p.from})  ${p.status}/${p.tg}`);
}

if (write) {
  let filled = 0;
  for (const p of plan) {
    const loc = resolveLocation({ gisCity: p.from === "2gis" ? p.city : null, aiCity: p.city });
    const r = await prisma.boutique.updateMany({
      where: { id: p.id, city: null },
      data: { city: loc.city, region: loc.region, country: loc.country },
    });
    filled += r.count;
  }
  console.log(`\n  filled: ${filled}`);
}

await prisma.$disconnect();
