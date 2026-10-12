import { afterEach, describe, expect, it, vi } from "vitest";

import { IMAGES_EXPIRED, IMAGES_UNREACHABLE } from "@/lib/instagram-image";
import { ALMATY } from "@/lib/location";

import { PublicationError, type PublishableBoutique } from "./publication-target";
import { refusedAlbumItem, TelegramChannelTarget } from "./telegram-target";

function boutique(over: Partial<PublishableBoutique> = {}): PublishableBoutique {
  return {
    id: "b1",
    name: "Test",
    city: null,
    overrideCity: null,
    categories: [],
    hashtags: [],
    followersCount: null,
    bio: null,
    instagramUrl: null,
    externalUrl: null,
    avatarUrl: null,
    posts: [],
    ...over,
  };
}

const almatyChannel = new TelegramChannelTarget({
  id: "telegram:almaty",
  label: "Telegram — Almaty",
  eligibleCity: ALMATY,
  token: "token",
  chatId: "@chan",
  // Every host is reachable unless a test says otherwise — no real DNS in tests.
  hasIpv4Address: async () => true,
});

describe("TelegramChannelTarget.isEligible", () => {
  it("accepts a boutique detected in the channel's city", () => {
    expect(almatyChannel.isEligible(boutique({ city: "Алматы" }))).toBe(true);
    // Canonicalized, so spelling variants of the same city still match.
    expect(almatyChannel.isEligible(boutique({ city: "Almaty" }))).toBe(true);
  });

  it("rejects another city and an undetected one", () => {
    expect(almatyChannel.isEligible(boutique({ city: "Астана" }))).toBe(false);
    expect(almatyChannel.isEligible(boutique({ city: null }))).toBe(false);
  });

  it("accepts an undetected city once an admin confirmed it via the override", () => {
    expect(almatyChannel.isEligible(boutique({ city: null, overrideCity: "Алматы" }))).toBe(true);
  });

  it("ignores an override for a different city", () => {
    expect(almatyChannel.isEligible(boutique({ city: null, overrideCity: "Астана" }))).toBe(false);
  });

  it("treats the override as additive — it never invalidates a detected match", () => {
    expect(almatyChannel.isEligible(boutique({ city: "Алматы", overrideCity: "Астана" }))).toBe(
      true,
    );
  });
});

describe("TelegramChannelTarget.publish — expired Instagram image links", () => {
  const HOUR = 3600 * 1000;
  // Fixed once: a link built again after an awaited publish must not cross a
  // second boundary and come out with a different oe.
  const NOW = Date.now();
  const ig = (offsetMs: number, name: string) =>
    `https://scontent.cdninstagram.com/v/${name}.jpg?oe=${Math.floor(
      (NOW + offsetMs) / 1000,
    ).toString(16)}`;
  const dead = (name: string) => ig(-72 * HOUR, name);
  const live = (name: string) => ig(48 * HOUR, name);
  const post = (imageUrl: string) => ({
    imageUrl,
    caption: null,
    likes: null,
    comments: null,
    permalink: null,
  });

  function stubTelegram() {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const sentMedia = (fetchMock: ReturnType<typeof vi.fn>) =>
    (
      JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { media: { media: string }[] }
    ).media.map((m) => m.media);

  afterEach(() => vi.unstubAllGlobals());

  /**
   * REGRESSION — every link had expired, Telegram answered WEBPAGE_CURL_FAILED
   * for the whole album, and Retry sent the same dead links again.
   */
  it("fails with IMAGES_EXPIRED and sends nothing when every link has expired", async () => {
    const fetchMock = stubTelegram();
    const b = boutique({ avatarUrl: dead("a"), posts: [post(dead("p1")), post(dead("p2"))] });

    const error = await almatyChannel.publish(b).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PublicationError);
    expect((error as PublicationError).code).toBe(IMAGES_EXPIRED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the dead links out and sends the live ones", async () => {
    const fetchMock = stubTelegram();
    const b = boutique({
      avatarUrl: live("a"),
      posts: [post(dead("p1")), post(live("p2")), post(dead("p3"))],
    });

    await almatyChannel.publish(b);

    expect(fetchMock.mock.calls[0]![0]).toContain("/sendMediaGroup");
    expect(sentMedia(fetchMock)).toEqual([live("a"), live("p2")]);
  });

  it("sends links without an expiry as they are — our own storage never expires", async () => {
    const fetchMock = stubTelegram();
    const ours = (n: string) => `https://proj.supabase.co/storage/v1/object/public/b/${n}.jpg`;
    const b = boutique({ avatarUrl: ours("a"), posts: [post(ours("p1"))] });

    await almatyChannel.publish(b);

    expect(sentMedia(fetchMock)).toEqual([ours("a"), ours("p1")]);
  });

  it("still posts the text alone for a boutique that never had images", async () => {
    const fetchMock = stubTelegram();

    await almatyChannel.publish(boutique());

    expect(fetchMock.mock.calls[0]![0]).toContain("/sendMessage");
  });
});

describe("TelegramChannelTarget.publish — edge hosts Telegram cannot reach", () => {
  const future = Math.floor((Date.now() + 48 * 3600 * 1000) / 1000).toString(16);
  const on = (host: string, name: string) =>
    `https://${host}/v/t51/${name}.jpg?oe=${future}&oh=sig`;
  const post = (imageUrl: string) => ({
    imageUrl,
    caption: null,
    likes: null,
    comments: null,
    permalink: null,
  });

  afterEach(() => vi.unstubAllGlobals());

  /**
   * REGRESSION — ostin.kz and lecarat.jewelry had every image still valid, but
   * one link in each sat on instagram.fcps4-2.fna.fbcdn.net, a host with an
   * IPv6 address only. It loaded fine from here; Telegram, fetching over IPv4,
   * rejected both whole albums with WEBPAGE_CURL_FAILED.
   */
  it("leaves out a link whose host has no IPv4 address, and sends the rest", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const gone = "instagram.fcps4-2.fna.fbcdn.net";
    const hasIpv4Address = vi.fn(async (host: string) => host !== gone);
    const channel = new TelegramChannelTarget({
      id: "telegram:almaty",
      label: "Telegram — Almaty",
      eligibleCity: ALMATY,
      token: "token",
      chatId: "@chan",
      hasIpv4Address,
    });
    const ours = "https://proj.supabase.co/storage/v1/object/public/b/x.jpg";

    await channel.publish(
      boutique({
        avatarUrl: on("scontent-ams2-1.cdninstagram.com", "a"),
        posts: [post(on(gone, "p1")), post(ours)],
      }),
    );

    const media = (
      JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { media: { media: string }[] }
    ).media.map((m) => m.media);
    expect(media).toEqual([on("scontent-ams2-1.cdninstagram.com", "a"), ours]);
    // Only Instagram's own hosts are looked up, each once.
    expect(hasIpv4Address.mock.calls.map(([host]) => host).sort()).toEqual(
      [gone, "scontent-ams2-1.cdninstagram.com"].sort(),
    );
  });
});

describe("TelegramChannelTarget.publish — an image Telegram refuses", () => {
  const future = Math.floor((Date.now() + 48 * 3600 * 1000) / 1000).toString(16);
  const img = (name: string) =>
    `https://scontent-ams2-1.cdninstagram.com/v/${name}.jpg?oe=${future}`;
  const post = (imageUrl: string) => ({
    imageUrl,
    caption: null,
    likes: null,
    comments: null,
    permalink: null,
  });
  const album = boutique({ avatarUrl: img("a"), posts: [post(img("p1")), post(img("p2"))] });

  const ok = () =>
    ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    }) as unknown as Response;
  const refused = (position: number) =>
    ({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: `Bad Request: failed to send message #${position} with the error message "WEBPAGE_CURL_FAILED"`,
        }),
    }) as unknown as Response;
  const sent = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
    JSON.parse(fetchMock.mock.calls[call]![1].body as string) as {
      media: { media: string; caption?: string }[];
    };

  afterEach(() => vi.unstubAllGlobals());

  /**
   * REGRESSION — mali.almaty and gold.ghetto.new failed twice in a row on the
   * same image: every link valid and reachable over IPv4, yet Telegram could
   * not load one of them and refused the whole album over it.
   */
  it("drops the image Telegram names and sends the rest", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(refused(3)).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    await almatyChannel.publish(album);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(fetchMock, 1).media.map((m) => m.media)).toEqual([img("a"), img("p1")]);
  });

  it("keeps the caption on the first image when the first one is dropped", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(refused(1)).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    await almatyChannel.publish(album);

    const media = sent(fetchMock, 1).media;
    expect(media.map((m) => m.media)).toEqual([img("p1"), img("p2")]);
    expect(media[0]!.caption).toContain("<b>Test</b>");
  });

  it("does not retry a failure that is not about one image", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ ok: false, description: "Bad Request: chat not found" }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(almatyChannel.publish(album)).rejects.toThrow("chat not found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after a few refusals instead of whittling the album down forever", async () => {
    const many = boutique({
      avatarUrl: img("a"),
      posts: ["p1", "p2", "p3", "p4", "p5", "p6"].map((n) => post(img(n))),
    });
    const fetchMock = vi.fn().mockResolvedValue(refused(2));
    vi.stubGlobal("fetch", fetchMock);

    await expect(almatyChannel.publish(many)).rejects.toThrow("WEBPAGE_CURL_FAILED");
    // The first attempt and three resends, each one image shorter.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sent(fetchMock, 3).media).toHaveLength(4);
  });
});

describe("refusedAlbumItem", () => {
  it("reads the position out of Telegram's refusal", () => {
    const error = new PublicationError(
      'Telegram sendMediaGroup failed (HTTP 400): Bad Request: failed to send message #4 with the error message "WEBPAGE_CURL_FAILED"',
    );
    expect(refusedAlbumItem(error)).toBe(4);
  });

  it("is null for anything else", () => {
    expect(refusedAlbumItem(new PublicationError("Bad Request: chat not found"))).toBeNull();
    expect(
      refusedAlbumItem(new Error("failed to send message #2 with the error message")),
    ).toBeNull();
  });
});

describe("TelegramChannelTarget.publish — no live image Telegram can reach", () => {
  const future = Math.floor((Date.now() + 48 * 3600 * 1000) / 1000).toString(16);
  const on = (host: string, name: string) => `https://${host}/v/${name}.jpg?oe=${future}`;
  const post = (imageUrl: string) => ({
    imageUrl,
    caption: null,
    likes: null,
    comments: null,
    permalink: null,
  });

  afterEach(() => vi.unstubAllGlobals());

  /**
   * A fault of this boutique's stored links, like expired ones: it must carry
   * a code, so the run does not count it toward stopping and the card offers
   * Re-parse rather than a Retry that sends the same links again.
   */
  it("fails with IMAGES_UNREACHABLE and sends nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const channel = new TelegramChannelTarget({
      id: "telegram:almaty",
      label: "Telegram — Almaty",
      eligibleCity: ALMATY,
      token: "token",
      chatId: "@chan",
      hasIpv4Address: async () => false,
    });

    const error = await channel
      .publish(
        boutique({
          avatarUrl: on("instagram.fcps4-2.fna.fbcdn.net", "a"),
          posts: [post(on("instagram.fcps4-2.fna.fbcdn.net", "p1"))],
        }),
      )
      .catch((e: unknown) => e);

    expect((error as PublicationError).code).toBe(IMAGES_UNREACHABLE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("TelegramChannelTarget.publish — the time budget", () => {
  const future = Math.floor((Date.now() + 48 * 3600 * 1000) / 1000).toString(16);
  const img = (name: string) =>
    `https://scontent-ams2-1.cdninstagram.com/v/${name}.jpg?oe=${future}`;
  const post = (imageUrl: string) => ({
    imageUrl,
    caption: null,
    likes: null,
    comments: null,
    permalink: null,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * REGRESSION target: four sends of up to 20s each outlived the 60s function
   * limit. A function killed mid-send records nothing — the boutique stays
   * PENDING at the head of the queue, and a send that landed is posted again.
   */
  it("does not start a resend that would run past the budget", async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const fetchMock = vi.fn().mockImplementation(async () => {
      clock += 40_000; // Telegram took 40s to refuse an image.
      return {
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            ok: false,
            description:
              'Bad Request: failed to send message #2 with the error message "WEBPAGE_CURL_FAILED"',
          }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      almatyChannel.publish(
        boutique({ avatarUrl: img("a"), posts: [post(img("p1")), post(img("p2"))] }),
      ),
    ).rejects.toThrow("WEBPAGE_CURL_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
