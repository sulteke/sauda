import "server-only";

import { ALMATY, canonicalKzCity } from "@/lib/location";
import { formatNumber } from "@/utils/format";

import { PublicationError, type PublicationTarget, type PublishableBoutique } from "./publication-target";

const TELEGRAM_API = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 20_000;
const CAPTION_LIMIT = 1024; // Telegram media-caption max length.
const MAX_MEDIA = 10; // Telegram sendMediaGroup max items.
const MAX_HASHTAGS = 5; // Show only the top 3–5 categories.

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

  constructor(config: TelegramChannelConfig) {
    this.id = config.id;
    this.label = config.label;
    this.eligibleCity = config.eligibleCity;
    this.token = config.token;
    this.chatId = config.chatId;
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

  private async call(method: string, body: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
        throw new PublicationError(`Telegram request timed out after ${REQUEST_TIMEOUT_MS}ms`, {
          httpStatus: null,
          response: null,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Publishes avatar + up to 6 post images as an album, with a rich caption. */
  async publish(boutique: PublishableBoutique): Promise<void> {
    if (!this.token || !this.chatId) {
      throw new Error("Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID.");
    }

    const caption = buildCaption(boutique);
    const images = [boutique.avatarUrl, ...boutique.posts.slice(0, 6).map((post) => post.imageUrl)]
      .filter((url): url is string => typeof url === "string" && url.length > 0)
      .slice(0, MAX_MEDIA);

    if (images.length >= 2) {
      await this.call("sendMediaGroup", {
        chat_id: this.chatId,
        media: images.map((url, index) =>
          index === 0
            ? { type: "photo", media: url, caption, parse_mode: "HTML" }
            : { type: "photo", media: url },
        ),
      });
    } else if (images.length === 1) {
      await this.call("sendPhoto", {
        chat_id: this.chatId,
        photo: images[0],
        caption,
        parse_mode: "HTML",
      });
    } else {
      await this.call("sendMessage", { chat_id: this.chatId, text: caption, parse_mode: "HTML" });
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
