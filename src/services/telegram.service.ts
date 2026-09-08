import "server-only";

import { categoryLabel } from "@/lib/category-engine";
import { prisma } from "@/lib/prisma";
import type { BoutiquePost } from "@/types";
import { formatNumber } from "@/utils/format";

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

/** Shape needed to build a Telegram post — sourced entirely from stored data. */
interface PublishableBoutique {
  name: string;
  /** Final detected category labels, highest-scoring first. */
  categories: string[];
  followersCount: number | null;
  bio: string | null;
  instagramUrl: string | null;
  externalUrl: string | null;
  avatarUrl: string | null;
  posts: BoutiquePost[];
}

function buildCaption(boutique: PublishableBoutique): string {
  const lines: string[] = [`<b>${escapeHtml(boutique.name)}</b>`];

  const meta: string[] = [];
  if (boutique.followersCount != null)
    meta.push(`${formatNumber(boutique.followersCount)} followers`);
  if (meta.length > 0) lines.push(meta.join(" · "));

  if (boutique.bio) lines.push(`\n${escapeHtml(boutique.bio)}`);

  const links: string[] = [];
  if (boutique.instagramUrl) links.push(`📷 ${escapeHtml(boutique.instagramUrl)}`);
  if (boutique.externalUrl) links.push(`🌐 ${escapeHtml(boutique.externalUrl)}`);
  if (links.length > 0) lines.push(`\n${links.join("\n")}`);

  // Categories as hashtags — near the bottom, after the boutique information.
  const hashtags = boutique.categories.slice(0, MAX_HASHTAGS).map(toHashtag).filter(Boolean);
  if (hashtags.length > 0) lines.push(`\n🏷 Категориялар\n${hashtags.join(" ")}`);

  const caption = lines.join("\n");
  return caption.length > CAPTION_LIMIT ? `${caption.slice(0, CAPTION_LIMIT - 1)}…` : caption;
}

/** Thin wrapper around the Telegram Bot API. Knows nothing about boutiques. */
class TelegramPublisher {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
  ) {}

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
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
      if (!res.ok || !json.ok) {
        throw new Error(json.description ?? `Telegram API error (HTTP ${res.status})`);
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { name?: unknown }).name === "AbortError"
      ) {
        throw new Error(`Telegram request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Publishes avatar + up to 6 post images as an album, with a rich caption. */
  async publish(boutique: PublishableBoutique): Promise<void> {
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

/** Builds a publisher from the configured bot token + channel id. */
function getTelegramPublisher(): TelegramPublisher {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !chatId) {
    throw new Error("Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID.");
  }
  return new TelegramPublisher(token, chatId);
}

export interface TelegramProcessResult {
  processed: boolean;
  boutiqueId: string | null;
  status: "PUBLISHED" | "TELEGRAM_FAILED" | null;
  error: string | null;
  remaining: number;
}

async function countReadyToPublish(): Promise<number> {
  return prisma.boutique.count({ where: { status: "READY_TO_PUBLISH" } });
}

/**
 * Publishes the oldest READY_TO_PUBLISH boutique to Telegram using ONLY stored
 * data (no re-scrape). Marks PUBLISHED on success, TELEGRAM_FAILED + error on
 * failure. Never throws — the queue keeps moving.
 */
export async function processNextTelegramPost(): Promise<TelegramProcessResult> {
  const next = await prisma.boutique.findFirst({
    where: { status: "READY_TO_PUBLISH" },
    orderBy: { createdAt: "asc" },
  });

  if (!next) {
    return { processed: false, boutiqueId: null, status: null, error: null, remaining: 0 };
  }

  const posts = Array.isArray(next.posts) ? (next.posts as unknown as BoutiquePost[]) : [];
  // Final detected categories (auto + manual corrections), highest-scoring first.
  // productCategories is stored in merge order; resolve ids → labels preserving it.
  const categories = next.productCategories
    .map((id) => categoryLabel(id))
    .filter((label): label is string => label !== null);

  try {
    const publisher = getTelegramPublisher();
    await publisher.publish({
      name: next.name,
      categories,
      followersCount: next.followersCount,
      bio: next.bio,
      instagramUrl: next.instagramUrl,
      externalUrl: next.externalUrl,
      avatarUrl: next.avatarUrl,
      posts,
    });

    await prisma.boutique.update({
      where: { id: next.id },
      data: { status: "PUBLISHED", telegramError: null },
    });
    return {
      processed: true,
      boutiqueId: next.id,
      status: "PUBLISHED",
      error: null,
      remaining: await countReadyToPublish(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Telegram publish failed";
    await prisma.boutique.update({
      where: { id: next.id },
      data: { status: "TELEGRAM_FAILED", telegramError: message },
    });
    return {
      processed: true,
      boutiqueId: next.id,
      status: "TELEGRAM_FAILED",
      error: message,
      remaining: await countReadyToPublish(),
    };
  }
}
