import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BotApi } from "@/server/client-bot/client-bot-api";
import { hashtagKey } from "@/server/client-bot/client-bot";

const { findMany, findUnique } = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { boutique: { findMany, findUnique } } }));

import { type BotUpdate, handleClientBotUpdate } from "./client-bot.service";

/** No expiry in the link, so the image is never treated as stale. */
const LIVE = "https://img.example.com/shop.jpg";

const ALPHA = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const ASTANA = "33333333-3333-4333-8333-333333333333";
const DELTA = "44444444-4444-4444-8444-444444444444";

/** Rows in the shape the service reads from Prisma. */
const ROWS = [
  {
    id: ALPHA,
    name: "Alpha",
    status: "APPROVED",
    city: "Алматы",
    hashtags: ["#Обувь", "#Кеды"],
    createdAt: new Date("2026-10-03T00:00:00Z"),
    instagramUrl: "https://www.instagram.com/alpha",
    avatarUrl: LIVE,
    posts: [],
  },
  {
    id: BETA,
    name: "Beta",
    status: "APPROVED",
    city: "Алматы",
    hashtags: ["#Обувь"],
    createdAt: new Date("2026-10-02T00:00:00Z"),
    instagramUrl: null,
    avatarUrl: null,
    posts: [],
  },
  {
    id: ASTANA,
    name: "Astana shop",
    status: "APPROVED",
    city: "Астана",
    hashtags: ["#Обувь"],
    createdAt: new Date("2026-10-04T00:00:00Z"),
    instagramUrl: null,
    avatarUrl: LIVE,
    posts: [],
  },
  {
    id: DELTA,
    name: "Delta",
    status: "APPROVED",
    city: "Алматы",
    hashtags: ["#Кеды"],
    createdAt: new Date("2026-10-01T00:00:00Z"),
    instagramUrl: null,
    avatarUrl: null,
    posts: [],
  },
];

type Where = { status?: string; hashtags?: { has: string } };

/** Newest first, as the service orders them. */
function matching(where: Where) {
  return ROWS.filter(
    (row) =>
      (!where.status || row.status === where.status) &&
      (!where.hashtags || row.hashtags.includes(where.hashtags.has)),
  ).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
}

function fakeApi(failPhoto = false) {
  const call = vi.fn(async (method: string) => {
    if (failPhoto && method === "sendPhoto") throw new Error("WEBPAGE_CURL_FAILED");
    return { message_id: 900 };
  });
  const api: BotApi = { call };
  return { call, api };
}

const START: BotUpdate = { message: { chat: { id: 555 }, text: "/start" } };
const press = (data: string, messageId = 77): BotUpdate => ({
  callback_query: { id: "cbq1", data, message: { message_id: messageId, chat: { id: 555 } } },
});
const OBUV = hashtagKey("#Обувь");
const methods = (call: { mock: { calls: unknown[][] } }) => call.mock.calls.map(([m]) => m);
const bodyOf = (call: { mock: { calls: unknown[][] } }, index: number) =>
  call.mock.calls[index]![1] as Record<string, unknown>;

beforeEach(() => {
  findMany.mockReset();
  findUnique.mockReset();
  findMany.mockImplementation(async ({ where }: { where: Where }) => matching(where));
  findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => ROWS.find((row) => row.id === where.id) ?? null,
  );
});

describe("/start", () => {
  it("shows the Almaty hashtags with counts, silently, and leaves Astana out", async () => {
    const { call, api } = fakeApi();

    await handleClientBotUpdate(START, api);

    expect(methods(call)).toEqual(["sendMessage"]);
    expect(bodyOf(call, 0)).toMatchObject({ chat_id: 555, disable_notification: true });
    const labels = (
      bodyOf(call, 0).reply_markup as { inline_keyboard: { text: string }[][] }
    ).inline_keyboard
      .flat()
      .map((button) => button.text);
    expect(labels).toEqual(["#Кеды (2)", "#Обувь (2)"]);
  });

  it("ignores ordinary messages", async () => {
    const { call, api } = fakeApi();
    await handleClientBotUpdate({ message: { chat: { id: 555 }, text: "hi" } }, api);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("opening a category", () => {
  it("answers the press, shows the newest boutique as a photo, and removes the old message", async () => {
    const { call, api } = fakeApi();

    await handleClientBotUpdate(press(`cat:${OBUV}`), api);

    expect(methods(call)).toEqual(["answerCallbackQuery", "sendPhoto", "deleteMessage"]);
    expect(bodyOf(call, 1)).toMatchObject({
      photo: LIVE,
      parse_mode: "HTML",
      disable_notification: true,
    });
    expect(JSON.stringify(bodyOf(call, 1).reply_markup)).toContain(`next:${OBUV}:${ALPHA}`);
    expect(bodyOf(call, 2)).toEqual({ chat_id: 555, message_id: 77 });
  });

  it("falls back to a text card when Telegram cannot fetch the photo", async () => {
    const { call, api } = fakeApi(true);

    await handleClientBotUpdate(press(`cat:${OBUV}`), api);

    expect(methods(call)).toEqual([
      "answerCallbackQuery",
      "sendPhoto",
      "sendMessage",
      "deleteMessage",
    ]);
    expect(bodyOf(call, 2).text).toContain("Alpha");
  });

  it("returns to the menu when the category no longer exists", async () => {
    const { call, api } = fakeApi();

    await handleClientBotUpdate(press("cat:ffffffffffff"), api);

    expect(methods(call)).toEqual(["answerCallbackQuery", "sendMessage", "deleteMessage"]);
    expect(bodyOf(call, 1).text).toBe("Санатты таңдаңыз:");
  });
});

describe("next boutique", () => {
  it("moves to the boutique after the one on screen, without a next button on the last one", async () => {
    const { call, api } = fakeApi();

    await handleClientBotUpdate(press(`next:${OBUV}:${ALPHA}`), api);

    // Beta has no photo, so it is sent as text, and it is the last one.
    expect(methods(call)).toEqual(["answerCallbackQuery", "sendMessage", "deleteMessage"]);
    expect(bodyOf(call, 1).text).toContain("Beta");
    expect(JSON.stringify(bodyOf(call, 1).reply_markup)).not.toContain("next:");
  });

  it("says the category is finished after its last boutique", async () => {
    const { call, api } = fakeApi();

    await handleClientBotUpdate(press(`next:${OBUV}:${BETA}`), api);

    expect(methods(call)).toEqual(["answerCallbackQuery", "sendMessage", "deleteMessage"]);
    expect(bodyOf(call, 1).text).toContain("аяқталды");
  });

  it("starts from the top when the boutique on screen has disappeared", async () => {
    const { call, api } = fakeApi();

    await handleClientBotUpdate(press(`next:${OBUV}:99999999-9999-4999-8999-999999999999`), api);

    expect(methods(call)).toContain("sendPhoto");
    expect(JSON.stringify(bodyOf(call, 1))).toContain(LIVE);
  });
});
