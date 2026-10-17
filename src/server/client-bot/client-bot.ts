/**
 * Pure building blocks for the customer bot (@saudajasa_bot): the menu, the
 * boutique card, the callback format and the webhook secret check. Nothing in
 * this file calls Telegram or the database, so it is tested on its own.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** Hashtags in the menu. A longer list is hard to scan on a phone. */
export const MENU_LIMIT = 30;
/** Telegram's cap on a photo caption; a text message is never longer than this. */
const CAPTION_LIMIT = 1024;
/** Hashtags shown on a card. */
const CARD_HASHTAGS = 5;

export interface HashtagCount {
  hashtag: string;
  count: number;
}

export interface CardBoutique {
  id: string;
  name: string;
  city: string | null;
  hashtags: string[];
  instagramUrl: string | null;
}

export type BotCallback =
  | { action: "menu" }
  | { action: "category"; key: string }
  | { action: "next"; key: string; afterId: string };

export type Button = { text: string; callback_data: string } | { text: string; url: string };
export type InlineKeyboard = { inline_keyboard: Button[][] };

/**
 * A short, stable key for a hashtag. Telegram caps callback data at 64 bytes,
 * and a Cyrillic hashtag plus its prefix does not reliably fit.
 */
export function hashtagKey(hashtag: string): string {
  return createHash("sha256").update(hashtag).digest("hex").slice(0, 12);
}

const KEY = /^[0-9a-f]{12}$/;
const BOUTIQUE_ID = /^[0-9a-zA-Z-]{1,40}$/;

/** Reads a callback this bot created. Anything else is rejected. */
export function parseCallback(data: string | undefined): BotCallback | null {
  if (!data) return null;
  const parts = data.split(":");
  if (parts[0] === "menu" && parts.length === 1) return { action: "menu" };
  if (parts[0] === "cat" && parts.length === 2 && KEY.test(parts[1]!)) {
    return { action: "category", key: parts[1]! };
  }
  if (
    parts[0] === "next" &&
    parts.length === 3 &&
    KEY.test(parts[1]!) &&
    BOUTIQUE_ID.test(parts[2]!)
  ) {
    return { action: "next", key: parts[1]!, afterId: parts[2]! };
  }
  return null;
}

/** The start menu: one button per hashtag, two per row. */
export function buildMenu(categories: HashtagCount[]): {
  text: string;
  reply_markup?: InlineKeyboard;
} {
  const shown = categories.slice(0, MENU_LIMIT);
  if (shown.length === 0) {
    return { text: "Әзірге бутиктер жоқ. Кейінірек қайта көріңіз." };
  }
  const rows: Button[][] = [];
  for (let i = 0; i < shown.length; i += 2) {
    rows.push(
      shown.slice(i, i + 2).map((category) => ({
        text: `${category.hashtag} (${category.count})`,
        callback_data: `cat:${hashtagKey(category.hashtag)}`,
      })),
    );
  }
  return { text: "Санатты таңдаңыз:", reply_markup: { inline_keyboard: rows } };
}

/** One boutique: name, city and hashtags, then the navigation buttons. */
export function buildCard(
  boutique: CardBoutique,
  hashtag: string,
  hasNext: boolean,
): { caption: string; reply_markup: InlineKeyboard } {
  const lines = [`<b>${escapeHtml(boutique.name)}</b>`];
  if (boutique.city) lines.push(`📍 ${escapeHtml(boutique.city)}`);
  const tags = boutique.hashtags.slice(0, CARD_HASHTAGS).map(escapeHtml).join(" ");
  if (tags) lines.push(tags);

  const rows: Button[][] = [];
  if (hasNext) {
    rows.push([
      { text: "Келесі бутик ▶", callback_data: `next:${hashtagKey(hashtag)}:${boutique.id}` },
    ]);
  }
  if (boutique.instagramUrl?.startsWith("https://")) {
    rows.push([{ text: "Instagram", url: boutique.instagramUrl }]);
  }
  rows.push([{ text: "◀ Басқа санат", callback_data: "menu" }]);

  return {
    caption: truncate(lines.join("\n"), CAPTION_LIMIT),
    reply_markup: { inline_keyboard: rows },
  };
}

/** Constant-time check of the secret Telegram echoes back on every webhook call. */
export function isValidWebhookSecret(
  received: string | null,
  expected: string | undefined,
): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
