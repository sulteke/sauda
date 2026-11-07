/**
 * READ-ONLY audit: how much mall/location data we hold per boutique.
 * Writes nothing. Run in the Terminal panel:
 *
 *   node --env-file=.env node_modules/vite-node/vite-node.mjs --config vitest.config.ts scripts/audit-boutique-locations.mts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const boutiques = await prisma.boutique.count();
  const byStatus = await prisma.gisStore.groupBy({ by: ["status"], _count: true });
  console.log(`boutiques: ${boutiques}`);
  console.log("gis_stores by status:", byStatus.map((s) => `${s.status}=${s._count}`).join(", ") || "(empty)");

  const stores = await prisma.gisStore.findMany({
    where: { instagramHandle: { not: null } },
    select: { instagramHandle: true, locationId: true, locationName: true },
  });
  const handles = [...new Set(stores.map((s) => s.instagramHandle!.toLowerCase()))];
  const have = await prisma.boutique.findMany({
    where: { instagramHandle: { in: handles } },
    select: { instagramHandle: true },
  });
  const haveSet = new Set(have.map((b) => b.instagramHandle!.toLowerCase()));

  // handle -> distinct locations seen in 2GIS
  const locs = new Map<string, Set<string>>();
  for (const s of stores) {
    const h = s.instagramHandle!.toLowerCase();
    if (!locs.has(h)) locs.set(h, new Set());
    locs.get(h)!.add(s.locationName ?? s.locationId);
  }
  const multi = [...locs.entries()].filter(([h, l]) => haveSet.has(h) && l.size > 1);

  console.log(`gis_stores with an Instagram handle: ${stores.length} (${handles.length} distinct)`);
  console.log(`  of those, handle is already a Boutique: ${haveSet.size}`);
  console.log(`  boutiques seen in 2+ locations (the lost-location case): ${multi.length}`);
  for (const [h, l] of multi.slice(0, 15)) console.log(`   @${h}: ${[...l].join(" | ")}`);

  const withAddr = await prisma.boutique.count({ where: { businessAddress: { not: null as never } } });
  console.log(`boutiques with Instagram businessAddress: ${withAddr}`);
  console.log(`boutiques with NO gis_stores row (location unknown): ${boutiques - haveSet.size}`);
}

main().finally(() => prisma.$disconnect());
