import "server-only";

import { albumImageUrls, isImageLinkExpired } from "@/lib/instagram-image";
import { isAlmaty } from "@/lib/location";
import { prisma } from "@/lib/prisma";
import {
  buildCard,
  buildMenu,
  type CardBoutique,
  type HashtagCount,
  hashtagKey,
  parseCallback,
} from "@/server/client-bot/client-bot";
import type { BotApi } from "@/server/client-bot/client-bot-api";

/** The part of a Telegram update this bot reads. Everything else is ignored. */
export interface BotUpdate {
  message?: { chat: { id: number }; text?: string };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

type BoutiqueRow = CardBoutique & { avatarUrl: string | null; posts: unknown };

/**
 * Customers see only admin-approved boutiques in Almaty. Other cities are not
 * shown yet, so the menu never offers a category that has nothing in Almaty.
 */
async function visibleBoutiques(hashtag?: string) {
  const rows = await prisma.boutique.findMany({
    where: { status: "APPROVED", ...(hashtag ? { hashtags: { has: hashtag } } : {}) },
    select: { id: true, city: true, hashtags: true },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
  return rows.filter((row) => isAlmaty(row.city));
}

/** Hashtags with the number of visible boutiques that carry each one. */
export async function listCategories(): Promise<HashtagCount[]> {
  const counts = new Map<string, number>();
  for (const row of await visibleBoutiques()) {
    for (const tag of new Set(row.hashtags.filter(Boolean))) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([hashtag, count]) => ({ hashtag, count }))
    .sort((a, b) => b.count - a.count || a.hashtag.localeCompare(b.hashtag));
}

async function hashtagForKey(key: string): Promise<string | null> {
  const categories = await listCategories();
  return categories.find((category) => hashtagKey(category.hashtag) === key)?.hashtag ?? null;
}

async function loadBoutique(id: string): Promise<BoutiqueRow | null> {
  return prisma.boutique.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      city: true,
      hashtags: true,
      instagramUrl: true,
      avatarUrl: true,
      posts: true,
    },
  });
}

/** The first image Telegram can still fetch: the same rule the channel post uses. */
function pickPhoto(row: BoutiqueRow): string | null {
  const posts = Array.isArray(row.posts) ? (row.posts as { imageUrl?: string | null }[]) : [];
  const urls = albumImageUrls(
    row.avatarUrl,
    posts.map((post) => ({ imageUrl: post?.imageUrl ?? null })),
  );
  return urls.find((url) => !isImageLinkExpired(url)) ?? null;
}

async function sendMenu(api: BotApi, chatId: number): Promise<void> {
  const menu = buildMenu(await listCategories());
  await api.call("sendMessage", { chat_id: chatId, disable_notification: true, ...menu });
}

async function sendCard(
  api: BotApi,
  chatId: number,
  row: BoutiqueRow,
  hashtag: string,
  hasNext: boolean,
): Promise<void> {
  const card = buildCard(row, hashtag, hasNext);
  const photo = pickPhoto(row);
  if (photo) {
    try {
      await api.call("sendPhoto", {
        chat_id: chatId,
        photo,
        caption: card.caption,
        parse_mode: "HTML",
        reply_markup: card.reply_markup,
        disable_notification: true,
      });
      return;
    } catch {
      // Telegram could not fetch the image. The card still works as text.
    }
  }
  await api.call("sendMessage", {
    chat_id: chatId,
    text: card.caption,
    parse_mode: "HTML",
    reply_markup: card.reply_markup,
    disable_notification: true,
  });
}

/** Removes the message a button was pressed on. Failure is harmless: the chat just keeps it. */
async function deleteQuietly(api: BotApi, chatId: number, messageId: number | undefined) {
  if (messageId === undefined) return;
  await api
    .call("deleteMessage", { chat_id: chatId, message_id: messageId })
    .catch(() => undefined);
}

/** Position of the boutique after `afterId`. Starts at the top when that boutique is gone. */
function nextIndex(ids: string[], afterId: string): number {
  const at = ids.indexOf(afterId);
  return at < 0 ? 0 : at + 1;
}

async function handleCallback(
  query: NonNullable<BotUpdate["callback_query"]>,
  api: BotApi,
): Promise<void> {
  // Stop the button's loading spinner first.
  await api.call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => undefined);

  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  const action = parseCallback(query.data);
  if (chatId === undefined || !action) return;

  if (action.action === "menu") {
    await sendMenu(api, chatId);
    await deleteQuietly(api, chatId, messageId);
    return;
  }

  const hashtag = await hashtagForKey(action.key);
  if (!hashtag) {
    // The menu this button came from is stale: the category has no shops left.
    await sendMenu(api, chatId);
    await deleteQuietly(api, chatId, messageId);
    return;
  }

  const ids = (await visibleBoutiques(hashtag)).map((row) => row.id);
  const index = action.action === "next" ? nextIndex(ids, action.afterId) : 0;
  if (index >= ids.length) {
    await api.call("sendMessage", {
      chat_id: chatId,
      text: "Бұл санаттағы бутиктер аяқталды.",
      reply_markup: { inline_keyboard: [[{ text: "◀ Басқа санат", callback_data: "menu" }]] },
      disable_notification: true,
    });
    await deleteQuietly(api, chatId, messageId);
    return;
  }

  const row = await loadBoutique(ids[index]!);
  if (!row) {
    await sendMenu(api, chatId);
    await deleteQuietly(api, chatId, messageId);
    return;
  }

  await sendCard(api, chatId, row, hashtag, index + 1 < ids.length);
  await deleteQuietly(api, chatId, messageId);
}

/**
 * Handles one Telegram update. `/start` opens the hashtag menu; a button press
 * either opens a category, moves to the next boutique, or returns to the menu.
 * The card replaces the previous one, so the chat does not fill up.
 */
export async function handleClientBotUpdate(update: BotUpdate, api: BotApi): Promise<void> {
  if (update.callback_query) {
    await handleCallback(update.callback_query, api);
    return;
  }
  const chatId = update.message?.chat.id;
  const text = update.message?.text?.trim() ?? "";
  if (chatId !== undefined && /^\/start(@\S+)?(\s|$)/.test(text)) {
    await sendMenu(api, chatId);
  }
}
