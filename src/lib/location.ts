/**
 * Location knowledge for boutiques — the single source of truth for Kazakhstan
 * city recognition, canonicalization, and the Almaty-only Telegram rule.
 *
 * Pure and framework-agnostic (no DB, no network, no "server-only"), so it is
 * shared by the enrichment engine, the import pipeline, the approval flow, the
 * Telegram publisher, and the client-side boutique filters alike.
 */

/** Country attached to any recognized Kazakhstan city. */
export const COUNTRY_KAZAKHSTAN = "Kazakhstan";

/** Canonical display name for Almaty — the only Telegram-eligible city today. */
export const ALMATY = "Алматы";

/** Canonical display names used by the boutique list filters. */
export const ASTANA = "Астана";
export const SHYMKENT = "Шымкент";

/**
 * Kazakhstan cities (canonical Cyrillic display + recognized variants in
 * Cyrillic / Latin / Kazakh). Used both for bio-based detection (enrichment)
 * and for canonicalizing an arbitrary city string (e.g. an AI-provided city).
 */
export const KZ_CITIES: { display: string; variants: string[] }[] = [
  { display: ALMATY, variants: ["алматы", "almaty", "алма-ата", "алма ата", "алматинская"] },
  {
    display: ASTANA,
    variants: [
      "астана",
      "астане",
      "астаны",
      "astana",
      "нур-султан",
      "нурсултан",
      "nur-sultan",
      "nursultan",
    ],
  },
  { display: SHYMKENT, variants: ["шымкент", "шымкенте", "shymkent", "чимкент"] },
  {
    display: "Караганда",
    variants: ["караганда", "караганде", "караганды", "karaganda", "қарағанды"],
  },
  { display: "Актобе", variants: ["актобе", "aktobe", "ақтөбе"] },
  { display: "Тараз", variants: ["тараз", "таразе", "taraz"] },
  { display: "Павлодар", variants: ["павлодар", "павлодаре", "pavlodar"] },
  { display: "Усть-Каменогорск", variants: ["усть-каменогорск", "ust-kamenogorsk", "өскемен"] },
  { display: "Семей", variants: ["семей", "семее", "semey", "семипалатинск"] },
  { display: "Атырау", variants: ["атырау", "atyrau"] },
  { display: "Костанай", variants: ["костанай", "костанае", "kostanay", "қостанай"] },
  {
    display: "Кызылорда",
    variants: ["кызылорда", "кызылорде", "кызылорды", "kyzylorda", "қызылорда"],
  },
  { display: "Уральск", variants: ["уральск", "уральске", "uralsk"] },
  { display: "Петропавловск", variants: ["петропавловск", "петропавловске", "petropavlovsk"] },
  { display: "Актау", variants: ["актау", "aktau"] },
  { display: "Кокшетау", variants: ["кокшетау", "kokshetau"] },
  { display: "Талдыкорган", variants: ["талдыкоргане", "талдыкорган", "taldykorgan"] },
  { display: "Туркестан", variants: ["туркестан", "туркестане", "turkestan", "түркістан"] },
];

/** Fast lookup: every recognized variant (and display) → canonical display. */
const VARIANT_TO_DISPLAY = new Map<string, string>();
for (const city of KZ_CITIES) {
  VARIANT_TO_DISPLAY.set(city.display.toLowerCase(), city.display);
  for (const variant of city.variants) VARIANT_TO_DISPLAY.set(variant, city.display);
}

/**
 * Canonicalizes an arbitrary city string to its Kazakhstan display name, or
 * null if it is not a recognized KZ city. Tolerates casing, surrounding country
 * text ("Almaty, Kazakhstan"), and the Cyrillic/Latin/Kazakh variants above.
 */
export function canonicalKzCity(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;

  // Direct match (handles "алматы", "almaty", canonical display, etc.).
  const direct = VARIANT_TO_DISPLAY.get(normalized);
  if (direct) return direct;

  // First comma segment ("Almaty, Kazakhstan" → "almaty").
  const head = normalized.split(",")[0]?.trim();
  if (head && head !== normalized) {
    const byHead = VARIANT_TO_DISPLAY.get(head);
    if (byHead) return byHead;
  }

  return null;
}

/** True when the given city is Almaty (the only Telegram-eligible city today). */
export function isAlmaty(city: string | null | undefined): boolean {
  return canonicalKzCity(city) === ALMATY;
}

/** Resolved location stored on a boutique. */
export interface ResolvedLocation {
  city: string | null;
  region: string | null;
  country: string | null;
}

/**
 * The city a 2GIS place link belongs to, read from the link itself.
 *
 * 2GIS puts the city in the first path segment — `2gis.kz/almaty/firm/…`,
 * `2gis.kz/astana/inside/…` — so a store discovered there carries its city in
 * the very URL we already store, with no extra lookup. Returns the canonical
 * Kazakhstan display name, or null for any link that is not a recognizable
 * 2GIS city URL.
 */
export function cityFromGisUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)2gis\./i.test(parsed.hostname)) return null;
  const slug = parsed.pathname.split("/").filter(Boolean)[0];
  return canonicalKzCity(slug);
}

/**
 * Resolves the location to persist from the signals we already have, most
 * trustworthy first:
 *
 *  1. the enrichment-detected city — deterministic, read from the shop's own bio;
 *  2. the 2GIS city — where the store we discovered physically IS, which is
 *     ground truth rather than an inference;
 *  3. the AI-provided city — a model's reading of the profile, the weakest.
 *
 * A recognized KZ city is canonicalized and tagged with the country; an
 * unrecognized city string is kept verbatim (so it still shows on the website /
 * under the "Other" filter) with an unknown country. Region has no reliable
 * source yet and stays null (optional, future-proofed).
 */
export function resolveLocation(input: {
  enrichmentCity?: string | null;
  gisCity?: string | null;
  aiCity?: string | null;
  region?: string | null;
}): ResolvedLocation {
  const raw = input.enrichmentCity?.trim() || input.gisCity?.trim() || input.aiCity?.trim() || null;
  if (!raw) return { city: null, region: input.region ?? null, country: null };

  const canonical = canonicalKzCity(raw);
  if (canonical) {
    return { city: canonical, region: input.region ?? null, country: COUNTRY_KAZAKHSTAN };
  }
  return { city: raw, region: input.region ?? null, country: null };
}
