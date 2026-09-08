/**
 * Structured business information extracted from already-imported data (bio,
 * external links, and Apify's business address). No additional scraping — this
 * is a pure derivation. Plain type — safe on server and client.
 */
export interface BoutiqueEnrichment {
  /** Phone numbers, normalized to E.164-ish (+7XXXXXXXXXX for KZ). */
  phones: string[];
  /** WhatsApp links (wa.me / whatsapp.com), normalized. */
  whatsapp: string[];
  /** Telegram references (@username or t.me link). */
  telegram: string[];
  /** 2GIS map links. */
  twoGis: string[];
  /** Google Maps links. */
  googleMaps: string[];
  /** Primary website (non-social, non-Taplink). */
  website: string | null;
  /** Taplink link tree, if the boutique uses one. */
  taplink: string | null;
  /** City (from the business address, or detected in the bio). */
  city: string | null;
  /** Street address (from the business address, or detected in the bio). */
  address: string | null;
  /** Delivery regions mentioned in the bio. */
  deliveryRegions: string[];
  /** Business hours found in the bio, if any. */
  businessHours: string | null;
}
