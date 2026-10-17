import { NextResponse } from "next/server";

import { isValidWebhookSecret } from "@/server/client-bot/client-bot";
import { TelegramBotApi } from "@/server/client-bot/client-bot-api";
import { type BotUpdate, handleClientBotUpdate } from "@/services/client-bot.service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Webhook for the customer bot. Telegram POSTs every update here and echoes the
 * secret we registered in `X-Telegram-Bot-Api-Secret-Token`. Anything without
 * that secret is refused, so the public URL cannot be used to drive the bot.
 */
export async function POST(request: Request) {
  const token = process.env.TELEGRAM_CLIENT_BOT_TOKEN;
  const secret = process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET;
  if (!token || !secret) {
    return NextResponse.json({ error: "Customer bot is not configured" }, { status: 503 });
  }
  if (!isValidWebhookSecret(request.headers.get("x-telegram-bot-api-secret-token"), secret)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let update: BotUpdate;
  try {
    update = (await request.json()) as BotUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    await handleClientBotUpdate(update, new TelegramBotApi(token));
  } catch (error) {
    // Answer 200 anyway: any other status makes Telegram retry, and a retry
    // would send the same reply again.
    console.error("Customer bot update failed:", error);
  }
  return NextResponse.json({ ok: true });
}
