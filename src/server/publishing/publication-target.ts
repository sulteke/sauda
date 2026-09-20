import type { BoutiquePost } from "@/types";

/**
 * Publishing seam. A PublicationTarget is any destination an approved boutique
 * can be pushed to — a Telegram channel today; tomorrow additional Telegram
 * channels (Astana, Shymkent), the website, Instagram, WhatsApp, etc.
 *
 * The contract is deliberately small and self-describing so a new target is
 * added by implementing this interface and registering it — WITHOUT touching the
 * approval workflow, the import pipeline, or the queue driver. Targets decide
 * their own eligibility (e.g. by city) and own all of their destination-specific
 * details (API calls, formatting, credentials).
 */

/** Destination-agnostic snapshot of a boutique, sourced entirely from stored data. */
export interface PublishableBoutique {
  id: string;
  name: string;
  /** Detected city (drives per-target eligibility, e.g. Almaty-only). */
  city: string | null;
  /**
   * City an admin explicitly confirmed for publication when `city` could not be
   * detected. Targets treat it as EQUIVALENT to `city` for eligibility only;
   * the detected `city` above is never rewritten.
   */
  overrideCity: string | null;
  /** Final detected category labels, highest-scoring first. */
  categories: string[];
  /**
   * Whitelisted hashtags chosen by the AI. Empty for boutiques analyzed before
   * hashtags existed — targets fall back to the category labels.
   */
  hashtags: string[];
  followersCount: number | null;
  bio: string | null;
  instagramUrl: string | null;
  externalUrl: string | null;
  avatarUrl: string | null;
  posts: BoutiquePost[];
}

/**
 * Error a target throws when a publish attempt fails. Carries the FULL,
 * untruncated message plus the HTTP status and complete raw API response so the
 * engine can record rich diagnostics. Targets that don't have HTTP semantics can
 * throw a plain Error — the engine degrades gracefully (null status/response).
 */
export class PublicationError extends Error {
  readonly httpStatus: number | null;
  readonly response: string | null;

  constructor(
    message: string,
    options: { httpStatus?: number | null; response?: string | null; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "PublicationError";
    this.httpStatus = options.httpStatus ?? null;
    this.response = options.response ?? null;
  }
}

/** A single publication destination. */
export interface PublicationTarget {
  /** Stable identifier, e.g. "telegram:almaty". */
  readonly id: string;
  /** Human-readable label for logs / UI. */
  readonly label: string;
  /** Whether this target is wired up (credentials / config present). */
  isConfigured(): boolean;
  /** Whether this boutique should be published to this target (e.g. city match). */
  isEligible(boutique: PublishableBoutique): boolean;
  /** Publishes the boutique to this target. Throws on failure. */
  publish(boutique: PublishableBoutique): Promise<void>;
}
