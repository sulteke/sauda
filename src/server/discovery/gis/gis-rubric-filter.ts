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
  "бель", // нижнее бельё
  "трикотаж",
  "головные убор",
  "кожгалантере",
  "меха",
  "шуб",
  "спорттовар",
  "спортивная",
  "секонд-хенд",
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

/** Splits stores into the fashion-relevant ones and the rest. */
export function partitionByRubric<T extends { rubric?: string | null }>(
  stores: T[],
): { relevant: T[]; excluded: T[] } {
  const relevant: T[] = [];
  const excluded: T[] = [];
  for (const store of stores) {
    (isFashionRubric(store.rubric) ? relevant : excluded).push(store);
  }
  return { relevant, excluded };
}
