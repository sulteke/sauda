import type { BoutiqueEnrichment } from "@/types/enrichment";
import type { InstagramBusinessAddress, InstagramExternalLink } from "@/types/instagram";

/**
 * Boutique enrichment — derives structured business information from data we
 * ALREADY have (bio text, the profile's external links, and Apify's business
 * address). Pure and deterministic; performs no network I/O / scraping.
 */

export interface EnrichmentInput {
  biography: string | null;
  externalUrl: string | null;
  externalUrls: InstagramExternalLink[];
  businessAddress: InstagramBusinessAddress | null;
}

export const EMPTY_ENRICHMENT: BoutiqueEnrichment = {
  phones: [],
  whatsapp: [],
  telegram: [],
  twoGis: [],
  googleMaps: [],
  website: null,
  taplink: null,
  city: null,
  address: null,
  deliveryRegions: [],
  businessHours: null,
};

// Kazakhstan cities (Cyrillic + Latin + common variants) for bio-based detection.
const KZ_CITIES: { display: string; variants: string[] }[] = [
  { display: "Алматы", variants: ["алматы", "almaty", "алма-ата", "алма ата"] },
  {
    display: "Астана",
    variants: ["астана", "астане", "астаны", "astana", "нур-султан", "нурсултан", "nur-sultan", "nursultan"],
  },
  { display: "Шымкент", variants: ["шымкент", "шымкенте", "shymkent", "чимкент"] },
  { display: "Караганда", variants: ["караганда", "караганде", "караганды", "karaganda", "қарағанды"] },
  { display: "Актобе", variants: ["актобе", "aktobe", "ақтөбе"] },
  { display: "Тараз", variants: ["тараз", "таразе", "taraz"] },
  { display: "Павлодар", variants: ["павлодар", "павлодаре", "pavlodar"] },
  { display: "Усть-Каменогорск", variants: ["усть-каменогорск", "ust-kamenogorsk", "өскемен"] },
  { display: "Семей", variants: ["семей", "семее", "semey", "семипалатинск"] },
  { display: "Атырау", variants: ["атырау", "atyrau"] },
  { display: "Костанай", variants: ["костанай", "костанае", "kostanay", "қостанай"] },
  { display: "Кызылорда", variants: ["кызылорда", "кызылорде", "кызылорды", "kyzylorda", "қызылорда"] },
  { display: "Уральск", variants: ["уральск", "уральске", "uralsk"] },
  { display: "Петропавловск", variants: ["петропавловск", "петропавловске", "petropavlovsk"] },
  { display: "Актау", variants: ["актау", "aktau"] },
  { display: "Кокшетау", variants: ["кокшетау", "kokshetau"] },
  { display: "Талдыкорган", variants: ["талдыкорган", "талдыкоргане", "taldykorgan"] },
  { display: "Туркестан", variants: ["туркестан", "туркестане", "turkestan", "түркістан"] },
];

const URL_REGEX = /((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?)/gi;
const ADDRESS_KEYWORDS =
  /(ул\.|улиц|проспект|пр-т|пр\.|мкр|микрорайон|дом\b|д\.|тц|трц|тд|бц|бутик|этаж|адрес|address|street|avenue)/i;
const DELIVERY_KEYWORDS = /(доставка|доставляем|delivery|жеткіз\w*)/i;

const uniq = (arr: string[]): string[] => [...new Set(arr.filter(Boolean))];
const escapeRegExp = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pad = (v: string | undefined): string => (v ?? "").padStart(2, "0");

// --- URLs -----------------------------------------------------------------

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/[.,;)\]]+$/, "");
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function isGoogleMaps(host: string, path: string): boolean {
  if (host === "maps.app.goo.gl") return true;
  if (host === "goo.gl") return /^\/maps/.test(path);
  if (host.startsWith("maps.google")) return true;
  return host.includes("google.") && /\/maps/.test(path);
}

const SOCIAL_HOSTS =
  /(^|\.)(instagram\.com|facebook\.com|fb\.com|fb\.me|tiktok\.com|youtube\.com|youtu\.be|threads\.net|vk\.com|ok\.ru|twitter\.com|x\.com|pinterest\.)/;

function telegramRef(url: string): string {
  const handle = pathOf(url).replace(/^\//, "");
  return /^[A-Za-z0-9_]{3,32}$/.test(handle) ? `@${handle}` : url;
}

interface ClassifiedLinks {
  whatsapp: string[];
  telegram: string[];
  twoGis: string[];
  googleMaps: string[];
  website: string | null;
  taplink: string | null;
}

function classifyLinks(rawUrls: string[]): ClassifiedLinks {
  const whatsapp: string[] = [];
  const telegram: string[] = [];
  const twoGis: string[] = [];
  const googleMaps: string[] = [];
  let website: string | null = null;
  let taplink: string | null = null;
  const seen = new Set<string>();

  for (const raw of rawUrls) {
    const url = normalizeUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const host = hostOf(url);
    const path = pathOf(url);

    if (host === "wa.me" || host.endsWith("whatsapp.com")) whatsapp.push(url);
    else if (host === "t.me" || host === "telegram.me" || host === "telegram.dog")
      telegram.push(telegramRef(url));
    else if (host.includes("2gis")) twoGis.push(url);
    else if (isGoogleMaps(host, path)) googleMaps.push(url);
    else if (host.includes("taplink")) taplink ??= url;
    else if (!SOCIAL_HOSTS.test(host)) website ??= url;
  }

  return {
    whatsapp: uniq(whatsapp),
    telegram: uniq(telegram),
    twoGis: uniq(twoGis),
    googleMaps: uniq(googleMaps),
    website,
    taplink,
  };
}

// --- phones ---------------------------------------------------------------

function normalizePhone(raw: string): string | null {
  const hasPlus = raw.trim().startsWith("+");
  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (!hasPlus) {
    if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
    else if (digits.length === 10) digits = `7${digits}`; // local KZ number
  }
  if (digits.length < 10 || digits.length > 15) return null;
  return `+${digits}`;
}

function extractPhones(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n/)) {
    const matches = line.match(/\+?\d[\d()\-.\s]{7,}\d/g) ?? [];
    for (const candidate of matches) {
      const phone = normalizePhone(candidate);
      if (phone) out.push(phone);
    }
  }
  return uniq(out);
}

// --- text-based signals ---------------------------------------------------

function stripUrls(text: string): string {
  return text.replace(URL_REGEX, " ");
}

/** WhatsApp numbers written in the bio next to a WhatsApp keyword. */
function whatsappFromText(bio: string): string[] {
  const out: string[] = [];
  for (const line of bio.split(/\n/)) {
    if (!/whats\s*app|ватсап|вотсап|вацап/i.test(line)) continue;
    for (const phone of extractPhones(line)) out.push(`https://wa.me/${phone.replace(/\D/g, "")}`);
  }
  return out;
}

/** Telegram usernames written in the bio next to a Telegram keyword. */
function telegramFromText(bio: string): string[] {
  const out: string[] = [];
  const re = /(?:telegram|телеграм{1,2}|тг)\s*[:\-]?\s*@?([A-Za-z0-9_]{3,32})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bio)) !== null) if (m[1]) out.push(`@${m[1]}`);
  return uniq(out);
}

function matchIndex(text: string, keyword: string): number {
  const re = new RegExp(`(?<!\\p{L})${escapeRegExp(keyword)}(?!\\p{L})`, "iu");
  const m = re.exec(text);
  return m ? m.index : -1;
}

function detectCity(bio: string): string | null {
  let best: { display: string; idx: number } | null = null;
  for (const city of KZ_CITIES) {
    for (const variant of city.variants) {
      const idx = matchIndex(bio, variant);
      if (idx >= 0 && (best === null || idx < best.idx)) best = { display: city.display, idx };
    }
  }
  return best ? best.display : null;
}

/** Business-hours ranges like "10:00-22:00" or "с 10 до 22". */
function detectBusinessHours(bio: string): string | null {
  const set = new Set<string>();
  const range = /(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/g;
  let m: RegExpExecArray | null;
  while ((m = range.exec(bio)) !== null) {
    set.add(`${pad(m[1])}:${m[2]}–${pad(m[3])}:${m[4]}`);
  }
  const ru = /с\s*(\d{1,2})(?:[:.](\d{2}))?\s*до\s*(\d{1,2})(?:[:.](\d{2}))?/gi;
  while ((m = ru.exec(bio)) !== null) {
    set.add(`${pad(m[1])}:${m[2] ?? "00"}–${pad(m[3])}:${m[4] ?? "00"}`);
  }
  return set.size > 0 ? [...set].join(", ") : null;
}

function detectDeliveryRegions(bio: string): string[] {
  const out: string[] = [];
  const re =
    /(?:доставка|доставляем|delivery|жеткіз\w*)\s*[:\-—]?\s*(?:по\s+(?:все[йму]{1,2}\s+)?|across\s+|over\s+|to\s+)?([^\n.,;|]+)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bio)) !== null) {
    const region = m[1]?.trim();
    if (region && region.length >= 2 && region.length <= 60) out.push(region);
  }
  return uniq(out);
}

function detectAddress(bio: string): string | null {
  for (const rawLine of bio.split(/\n/)) {
    const line = stripUrls(rawLine)
      .replace(/(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/g, " ") // drop hours
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!line || DELIVERY_KEYWORDS.test(line)) continue;
    if (ADDRESS_KEYWORDS.test(line) || /[А-ЯЁA-Z][\wа-яё]+\s+\d{1,4}\b/.test(line)) {
      return line;
    }
  }
  return null;
}

// --- business address (structured, from Apify) ----------------------------

function cityFromAddress(a: InstagramBusinessAddress | null): string | null {
  if (!a?.cityName) return null;
  return a.cityName.split(",")[0]?.trim() || null;
}

function streetFromAddress(a: InstagramBusinessAddress | null): string | null {
  if (!a?.streetAddress) return null;
  return [a.streetAddress, a.zipCode].filter(Boolean).join(", ") || null;
}

// --- entry point ----------------------------------------------------------

/** Derives structured business info from already-imported profile data. */
export function enrichBoutique(input: EnrichmentInput): BoutiqueEnrichment {
  const bio = input.biography ?? "";

  const linkSources: string[] = [];
  for (const link of input.externalUrls ?? []) if (link?.url) linkSources.push(link.url);
  if (input.externalUrl) linkSources.push(input.externalUrl);
  for (const url of bio.match(URL_REGEX) ?? []) linkSources.push(url);

  const links = classifyLinks(linkSources);

  const phones = extractPhones(stripUrls(bio));
  const whatsapp = uniq([...links.whatsapp, ...whatsappFromText(bio)]);
  const telegram = uniq([...links.telegram, ...telegramFromText(bio)]);

  return {
    phones,
    whatsapp,
    telegram,
    twoGis: links.twoGis,
    googleMaps: links.googleMaps,
    website: links.website,
    taplink: links.taplink,
    city: cityFromAddress(input.businessAddress) ?? detectCity(bio),
    address: streetFromAddress(input.businessAddress) ?? detectAddress(bio),
    deliveryRegions: detectDeliveryRegions(bio),
    businessHours: detectBusinessHours(bio),
  };
}
