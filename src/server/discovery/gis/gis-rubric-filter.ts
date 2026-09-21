/**
 * Fashion-relevance filter for 2GIS venue results.
 *
 * A mall is mostly NOT boutiques: food courts, banks, cinemas, pharmacies,
 * phone repair. Sending those into the Instagram analyzer would waste the
 * scarce daily AI budget on businesses we would reject anyway, so relevance is
 * decided BEFORE anything leaves 2GIS.
 *
 * This is an allowlist, not a blocklist: a store passes only when its 2GIS
 * rubric positively matches fashion retail. Anything unrecognized is excluded,
 * which is the safe direction — a missed boutique can be added by widening the
 * list, while a wrongly-included bank costs real budget.
 */

/** Rubric substrings (lowercase) that mark a store as fashion retail. */
const FASHION_RUBRICS: readonly string[] = [
  "одежд", // магазин одежды, детская одежда, женская одежда, спортивная одежда
  "обув", // магазин обуви, детская обувь
  "аксессуар",
  "бижутери",
  "сумк",
  "украшени",
  "ювелир",
  "джинс",
  // Full words only: the stem "бель" also occurs inside "мебель", which put an
  // office-furniture shop through the filter on a real Aport run.
  "бельё",
  "белье",
  "нижнее бель",
  "трикотаж",
  "головные убор",
  "кожгалантере",
  "меха",
  "шуб",
  "спорттовар",
  "спортивная",
  "секонд-хенд",
  "носк",
  "колготк",
  "чулочно",
  "бутик",
  "модн",
  "очк", // оптика / солнцезащитные очки
  "часы",
  "clothing",
  "fashion",
  "boutique",
  "shoes",
  "footwear",
  "accessor",
  "sportswear",
];

/**
 * Rubrics that contain a fashion word but are NOT retail we want. Checked
 * first, so "ремонт обуви" and "прокат одежды" never slip through on "обув"/"одежд".
 */
const EXCLUDED_RUBRICS: readonly string[] = [
  "ремонт",
  "пошив",
  "ателье",
  "химчист",
  "прокат",
  "стирк",
  "оборудован",
  "манекен",
  "склад",
  "производств",
  "repair",
  "rental",
  "laundry",
];

/** Whether a 2GIS rubric describes a fashion-retail store. */
export function isFashionRubric(rubric: string | null | undefined): boolean {
  if (!rubric) return false; // no rubric = not positively relevant
  const value = rubric.toLocaleLowerCase("ru-RU");
  if (EXCLUDED_RUBRICS.some((term) => value.includes(term))) return false;
  return FASHION_RUBRICS.some((term) => value.includes(term));
}

/** A store as the filter sees it: its primary rubric, plus the full list. */
export interface RubricBearing {
  rubric?: string | null;
  rubrics?: readonly string[] | null;
}

/**
 * Judges a store by its PRIMARY rubric only.
 *
 * 2GIS lists several rubrics per store and the first is its identity, while the
 * rest are things it merely also stocks. Accepting any match would pull in a
 * supermarket that sells socks or a cosmetics shop with a hosiery shelf — real
 * examples from Aport Mall West — none of which are boutiques. Judging the
 * primary keeps "Reserved" and "Kimex" while rejecting "Magnum" and "Диона".
 *
 * The trade-off is a boutique filed under an unusual primary rubric being
 * missed; widening this later is a one-line change, whereas a wrongly-included
 * store costs real AI budget downstream.
 */
export function isFashionStore(store: RubricBearing): boolean {
  const primary = store.rubrics?.[0] ?? store.rubric ?? null;
  return isFashionRubric(primary);
}

/** Splits stores into the fashion-relevant ones and the rest. */
export function partitionByRubric<T extends RubricBearing>(
  stores: T[],
): { relevant: T[]; excluded: T[] } {
  const relevant: T[] = [];
  const excluded: T[] = [];
  for (const store of stores) {
    (isFashionStore(store) ? relevant : excluded).push(store);
  }
  return { relevant, excluded };
}

/**
 * Search terms used to PARTITION a venue into several queries.
 *
 * A single `building_id` query can only reach a bounded window (a demo key caps
 * at page 5 x page_size 10 = 50 results), while a mall holds hundreds. Querying
 * per fashion term gives each term its own window, so coverage is far wider AND
 * aimed at the stores we actually want — instead of paging through a food court
 * to reach a boutique.
 *
 * The empty string runs the plain venue query first, so small venues need only
 * one round trip.
 */
export const FASHION_QUERIES: readonly string[] = [
  "",
  "одежда",
  "обувь",
  "аксессуары",
  "сумки",
  "бельё",
  "спортивная одежда",
  "детская одежда",
  "ювелирные изделия",
  "очки",
  "часы",
];
