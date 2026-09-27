/**
 * Seeds the LOCAL database with a few realistic shops, ready to analyze.
 *
 * The parse stage is what would normally call Apify; these rows arrive already
 * parsed, so a local session can exercise the analyze stage — the part that
 * runs the model — without spending a scrape. Refuses to run against anything
 * but a local database.
 */
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
if (!/127\.0\.0\.1|localhost/.test(url)) {
  throw new Error(`REFUSING TO SEED: DATABASE_URL is not local → ${url.replace(/:[^:@]*@/, ":***@")}`);
}
const prisma = new PrismaClient({ datasources: { db: { url } } });

const post = (caption: string, i: number, tags: string[]) => ({
  imageUrl: `https://picsum.photos/seed/seed-${i}/500/500`,
  caption,
  likes: 120 + i * 37,
  comments: 4 + i,
  permalink: "https://www.instagram.com/",
  type: "Image",
  videoUrl: null,
  hashtags: tags,
  mentions: [],
  taggedUsers: [],
  locationName: i === 0 ? "Алматы" : null,
  locationId: null,
  childPosts: [],
  musicInfo: null,
  dimensions: { width: 500, height: 500 },
  isPinned: i === 0,
});

const SHOPS = [
  {
    handle: "local_women_denim",
    fullName: "ЖЕНСКАЯ ОДЕЖДА | АЛМАТЫ",
    biography: "Женская одежда в Алматы. Джинсы, футболки, худи. ТРЦ Dostyk Plaza.",
    followers: 18_400,
    captions: [
      "Новая коллекция женских джинсов — все размеры в наличии",
      "Базовые футболки, хлопок 100%",
      "Тёплые худи на осень",
      "Примерка в ТРЦ Dostyk Plaza, 2 этаж",
    ],
    tags: ["женскаяодежда", "джинсы", "алматы"],
  },
  {
    handle: "local_men_outerwear",
    fullName: "МУЖСКАЯ ОДЕЖДА",
    biography: "Мужская одежда: куртки, джинсы, футболки. Доставка по Казахстану.",
    followers: 9_750,
    captions: [
      "Зимние мужские куртки уже в продаже",
      "Джинсы прямого кроя",
      "Новые футболки в базовых цветах",
      "Тёплая коллекция на зиму",
    ],
    tags: ["мужскаяодежда", "куртки"],
  },
  {
    handle: "local_unisex_street",
    fullName: "UNISEX STREETWEAR ALMATY",
    biography: "Унисекс streetwear. Худи, свитшоты, футболки оверсайз.",
    followers: 12_100,
    captions: [
      "Oversized худи унисекс",
      "Свитшоты новой коллекции",
      "Футболки oversize, унисекс посадка",
      "Streetwear образы недели",
    ],
    tags: ["унисекс", "streetwear", "худи"],
  },
];

async function main() {
  console.log(`Seeding LOCAL database: ${url.replace(/:[^:@]*@/, ":***@")}\n`);

  // Idempotent: clear only what this script creates.
  const handles = SHOPS.map((s) => s.handle);
  await prisma.importQueue.deleteMany({
    where: { instagramUrl: { in: handles.map((h) => `https://instagram.com/${h}`) } },
  });
  await prisma.importJob.deleteMany({ where: { handle: { in: handles } } });
  await prisma.boutique.deleteMany({ where: { instagramHandle: { in: handles } } });

  for (const shop of SHOPS) {
    const sourceUrl = `https://instagram.com/${shop.handle}`;
    const rawProfile = {
      handle: shop.handle,
      fullName: shop.fullName,
      biography: shop.biography,
      profilePicUrl: null,
      externalUrl: null,
      followersCount: shop.followers,
      isVerified: false,
      recentPosts: shop.captions.map((c, i) => post(c, i, shop.tags)),
      postsCount: shop.captions.length,
      followsCount: 120,
      isBusinessAccount: true,
      isPrivate: false,
      businessAddress: null,
      externalUrls: [],
      relatedProfiles: [],
      sourceUrl,
      fetchedAt: new Date().toISOString(),
      raw: {},
    };

    const job = await prisma.importJob.create({
      data: {
        source: "INSTAGRAM",
        sourceUrl,
        handle: shop.handle,
        status: "PENDING",
        rawProfile: rawProfile as never,
      },
    });

    await prisma.importQueue.create({
      data: { instagramUrl: sourceUrl, status: "PENDING_ANALYSIS", importJobId: job.id },
    });

    console.log(`  queued @${shop.handle}  (${shop.followers.toLocaleString("en-US")} followers, ${shop.captions.length} posts)`);
  }

  const pending = await prisma.importQueue.count({ where: { status: "PENDING_ANALYSIS" } });
  console.log(`\nPENDING_ANALYSIS in local queue: ${pending}`);
  await prisma.$disconnect();
}

main();
