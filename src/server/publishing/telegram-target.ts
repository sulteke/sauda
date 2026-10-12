import "server-only";

import { lookup } from "node:dns/promises";

import {
  albumImageUrls,
  IMAGES_EXPIRED,
  IMAGES_UNREACHABLE,
  isImageLinkExpired,
  isInstagramCdnLink,
} from "@/lib/instagram-image";
import { ALMATY, canonicalKzCity } from "@/lib/location";
import { logger } from "@/lib/logger";
import { formatNumber } from "@/utils/format";

import {
  PublicationError,
  type PublicationTarget,
  type PublishableBoutique,
} from "./publication-target";

const TELEGRAM_API = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 20_000;
const CAPTION_LIMIT = 1024; // Telegram media-caption max length.
const MAX_MEDIA = 10; // Telegram sendMediaGroup max items.
const MAX_HASHTAGS = 5; // Show only the top 3–5 categories.
const DNS_TIMEOUT_MS = 3_000;
/** Images an album may lose to Telegram refusing them, before the post fails. */
const MAX_REFUSED_IMAGES = 3;
/**
 * Wall-clock budget for one publish, every resend included. The routes that
 * publish run under a 60s function limit, and a function killed mid-send
 * records nothing: the boutique stays PENDING at the head of the queue, and a
 * send Telegram finished anyway would be posted again on the next run. 45s
 * leaves room for the database work around the publish.
 */
const PUBLISH_BUDGET_MS = 45_000;
/** A resend is not started with less time than this left in the budget. */
const MIN_SEND_MS = 10_000;

/**
 * The album position (1-based) of the image Telegram could not take, read from
 * a refusal such as `failed to send message #3 with the error message
 * "WEBPAGE_CURL_FAILED"`. Null for any failure that is not about one image.
 */
export function refusedAlbumItem(error: unknown): number | null {
  if (!(error instanceof PublicationError)) return null;
  const match = /failed to send message #(\d+) with the error message/.exec(error.message);
  return match ? Number(match[1]) : null;
}

/**
 * Whether the host has an IPv4 address — Telegram fetches album images over
 * IPv4, so a host with only an IPv6 address is as good as gone to it, however
 * well it loads here. Only a definite "no such record" counts as no: a lookup
 * that errors otherwise, or does not answer in time, is taken as a yes, so a
 * flaky resolver leaves the link exactly as it was.
 *
 * Asks the operating system's resolver (`lookup`), not `resolve4`: the latter
 * reads the DNS servers once when the process starts, and after the network
 * changed under a running server it answered with errors that hid every
 * IPv6-only host.
 */
async function hasIpv4Address(host: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), DNS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      lookup(host, { family: 4, all: true }).then(
        (addresses) => addresses.length > 0,
        (error: { code?: string }) => {
          if (error.code === "ENOTFOUND" || error.code === "ENODATA") return false;
          logger.warn("telegram.dns_check_failed", { host, code: error.code ?? null });
          return true;
        },
      ),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Turns a category label into a Cyrillic-safe Telegram hashtag: splits on spaces
 * and punctuation, capitalizes each word, concatenates, and prefixes "#".
 * E.g. "Худи" → "#Худи", "Головной убор" → "#ГоловнойУбор".
 */
export function toHashtag(label: string): string {
  const body = label
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  return body ? `#${body}` : "";
}

export function buildCaption(boutique: PublishableBoutique): string {
  const lines: string[] = [`<b>${escapeHtml(boutique.name)}</b>`];

  const meta: string[] = [];
  if (boutique.followersCount != null)
    meta.push(`${formatNumber(boutique.followersCount)} followers`);
  if (meta.length > 0) lines.push(meta.join(" · "));

  if (boutique.bio) lines.push(`\n${escapeHtml(boutique.bio)}`);

  const links: string[] = [];
  // Show "Instagram" as the link text, never the raw URL (the URL stays the href).
  if (boutique.instagramUrl)
    links.push(`📷 <a href="${escapeHtml(boutique.instagramUrl)}">Instagram</a>`);
  if (boutique.externalUrl) links.push(`🌐 ${escapeHtml(boutique.externalUrl)}`);
  if (links.length > 0) lines.push(`\n${links.join("\n")}`);

  // Hashtags — near the bottom, after the boutique information. Prefer the
  // whitelisted tags the AI selected; boutiques analyzed before hashtags existed
  // have none, so they keep the original category-derived rendering.
  const hashtags = (
    boutique.hashtags.length > 0
      ? boutique.hashtags
      : boutique.categories.slice(0, MAX_HASHTAGS).map(toHashtag)
  )
    .filter(Boolean)
    .slice(0, MAX_HASHTAGS);
  if (hashtags.length > 0) lines.push(`\n🏷 Категориялар\n${hashtags.join(" ")}`);

  const caption = lines.join("\n");
  return caption.length > CAPTION_LIMIT ? `${caption.slice(0, CAPTION_LIMIT - 1)}…` : caption;
}

export interface TelegramChannelConfig {
  /** Stable id, e.g. "telegram:almaty". */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Canonical city this channel publishes (eligibility gate). */
  eligibleCity: string;
  /** Bot token + channel/chat id. Absent → not configured (publish throws). */
  token: string | undefined;
  chatId: string | undefined;
  /** Whether a host has an IPv4 address. Defaults to a DNS lookup; injectable for tests. */
  hasIpv4Address?: (host: string) => Promise<boolean>;
}

/**
 * A Telegram channel as a publication target. Owns everything Telegram-specific:
 * the Bot API calls, caption/album formatting, and the city eligibility gate.
 * Adding another city's channel is just another instance of this class.
 */
export class TelegramChannelTarget implements PublicationTarget {
  readonly id: string;
  readonly label: string;
  private readonly eligibleCity: string;
  private readonly token: string | undefined;
  private readonly chatId: string | undefined;
  private readonly hasIpv4Address: (host: string) => Promise<boolean>;

  constructor(config: TelegramChannelConfig) {
    this.id = config.id;
    this.label = config.label;
    this.eligibleCity = config.eligibleCity;
    this.token = config.token;
    this.chatId = config.chatId;
    this.hasIpv4Address = config.hasIpv4Address ?? hasIpv4Address;
  }

  /**
   * Leaves out Instagram links on edge hosts Telegram cannot reach.
   *
   * The scraper hands out links on whichever edge host served it, and some of
   * those hosts have no IPv4 address — IPv6 only, or gone from DNS entirely.
   * Telegram fetches over IPv4, cannot load such a link, and rejects the whole
   * album over it: two boutiques with every image still valid failed this way.
   * Moving the link to Instagram's main host did not help — Telegram refused
   * that too — so the image is left out and the album goes without it.
   */
  private async reachable(urls: string[]): Promise<string[]> {
    const hosts = new Set(urls.filter(isInstagramCdnLink).map((url) => new URL(url).hostname));
    const unreachable = new Set<string>();
    await Promise.all(
      [...hosts].map(async (host) => {
        if (!(await this.hasIpv4Address(host))) unreachable.add(host);
      }),
    );
    if (unreachable.size === 0) return urls;
    logger.info("telegram.images_left_out", {
      hosts: [...unreachable],
      reason: "Host has no IPv4 address; Telegram cannot fetch from it.",
    });
    return urls.filter(
      (url) => !(isInstagramCdnLink(url) && unreachable.has(new URL(url).hostname)),
    );
  }

  isConfigured(): boolean {
    return Boolean(this.token && this.chatId);
  }

  /**
   * Eligible when the DETECTED city matches, or when an admin explicitly
   * confirmed this city for a boutique whose location could not be detected.
   * The override is an eligibility signal only — it never edits the detection.
   */
  isEligible(boutique: PublishableBoutique): boolean {
    return (
      canonicalKzCity(boutique.city) === this.eligibleCity ||
      canonicalKzCity(boutique.overrideCity) === this.eligibleCity
    );
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${TELEGRAM_API}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Read the complete response body ONCE, so we can surface the full Telegram
      // API error (error_code, description, parameters) — never a truncated bit.
      const rawBody = await res.text().catch(() => "");
      let parsed: { ok?: boolean; description?: string } = {};
      try {
        parsed = rawBody ? (JSON.parse(rawBody) as { ok?: boolean; description?: string }) : {};
      } catch {
        parsed = {};
      }

      if (!res.ok || !parsed.ok) {
        const detail = parsed.description ?? rawBody;
        throw new PublicationError(
          `Telegram ${method} failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
          { httpStatus: res.status, response: rawBody || null },
        );
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { name?: unknown }).name === "AbortError"
      ) {
        throw new PublicationError(`Telegram request timed out after ${timeoutMs}ms`, {
          httpStatus: null,
          response: null,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Publishes avatar + up to 6 live post images as an album, with a rich caption. */
  async publish(boutique: PublishableBoutique): Promise<void> {
    if (!this.token || !this.chatId) {
      throw new Error(
        "Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID.",
      );
    }

    const deadline = Date.now() + PUBLISH_BUDGET_MS;
    const caption = buildCaption(boutique);
    // Telegram fetches each image itself and rejects the whole album over one
    // dead link, so expired ones are left out and the live ones still go.
    const linked = albumImageUrls(boutique.avatarUrl, boutique.posts);
    const live = linked.filter((url) => !isImageLinkExpired(url));

    // Every link is dead: Telegram can only refuse it, and a retry would send
    // the same links again. Say so without spending a call on it.
    if (linked.length > 0 && live.length === 0) {
      throw new PublicationError(
        "Instagram image links have expired, so Telegram cannot fetch them. Re-parse the boutique to get fresh ones.",
        { code: IMAGES_EXPIRED },
      );
    }

    const images = (await this.reachable(live)).slice(0, MAX_MEDIA);
    if (live.length > 0 && images.length === 0) {
      throw new PublicationError(
        "None of this boutique's Instagram images can be fetched by Telegram (their hosts have no IPv4 address). Re-parse the boutique to get new links.",
        { code: IMAGES_UNREACHABLE },
      );
    }

    /**
     * Telegram downloads every image itself, and some Instagram links it cannot
     * load even though they open fine from here: mali.almaty and
     * gold.ghetto.new failed twice in a row on the same image, every link valid
     * and reachable over IPv4. One refused image sinks the whole album, so the
     * image Telegram names is dropped and the rest are sent again. Bounded by
     * count and by the time budget, so a failure that is not about images is
     * not retried into a loop, and no resend can outlive the function.
     */
    let album = images;
    for (let refused = 0; ; refused += 1) {
      try {
        await this.send(album, caption, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()));
        return;
      } catch (error) {
        const position = album.length >= 2 ? refusedAlbumItem(error) : null;
        if (
          position === null ||
          position > album.length ||
          refused >= MAX_REFUSED_IMAGES ||
          deadline - Date.now() < MIN_SEND_MS
        ) {
          throw error;
        }
        logger.info("telegram.image_refused", {
          boutiqueId: boutique.id,
          position,
          host: new URL(album[position - 1]!).hostname,
          remaining: album.length - 1,
        });
        album = album.filter((_, index) => index !== position - 1);
      }
    }
  }

  /** Sends the caption with the images: an album, a single photo, or text alone. */
  private async send(images: string[], caption: string, timeoutMs: number): Promise<void> {
    if (images.length >= 2) {
      await this.call(
        "sendMediaGroup",
        {
          chat_id: this.chatId,
          media: images.map((url, index) =>
            index === 0
              ? { type: "photo", media: url, caption, parse_mode: "HTML" }
              : { type: "photo", media: url },
          ),
        },
        timeoutMs,
      );
    } else if (images.length === 1) {
      await this.call(
        "sendPhoto",
        { chat_id: this.chatId, photo: images[0], caption, parse_mode: "HTML" },
        timeoutMs,
      );
    } else {
      await this.call(
        "sendMessage",
        { chat_id: this.chatId, text: caption, parse_mode: "HTML" },
        timeoutMs,
      );
    }
  }
}

/**
 * The configured Telegram channels. Today there is exactly one — Almaty — which
 * reads the existing TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID env. To add more
 * channels later (Astana, Shymkent, …), register another TelegramChannelTarget
 * here (each gated by its own city + channel id); nothing else changes.
 */
export function getTelegramTargets(): PublicationTarget[] {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_ID;

  return [
    new TelegramChannelTarget({
      id: "telegram:almaty",
      label: "Telegram — Almaty",
      eligibleCity: ALMATY,
      token,
      chatId,
    }),
    // Example future channel (enabled only when its env is set):
    // ...(process.env.TELEGRAM_ASTANA_CHANNEL_ID
    //   ? [new TelegramChannelTarget({ id: "telegram:astana", label: "Telegram — Astana",
    //       eligibleCity: ASTANA, token, chatId: process.env.TELEGRAM_ASTANA_CHANNEL_ID })]
    //   : []),
  ];
}
