import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where a boutique's city comes from, and when it may be written.
 *
 * Exercised through runPersist, the lightest entry point into the shared
 * boutique write, with Prisma stubbed: the rules under test are about which
 * writes are issued, not about the database.
 */

const { importJob, boutique, discoveryCandidate } = vi.hoisted(() => ({
  importJob: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
  boutique: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
  discoveryCandidate: { findMany: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: { importJob, boutique, discoveryCandidate } }));

import { runPersist } from "./import-pipeline";

/** A saved preview with no city in the bio and none from the AI. */
const preview = (over: Record<string, unknown> = {}) => ({
  instagramHandle: "lucentekz",
  instagramUrl: "https://instagram.com/lucentekz",
  name: "Lucente",
  slug: "lucente",
  description: null,
  categoryScores: [],
  enrichment: { city: null },
  aiResult: null,
  hashtags: [],
  ...over,
});

const readyJob = (p: ReturnType<typeof preview>) => ({
  id: "job-1",
  status: "READY_FOR_REVIEW",
  preview: p,
});

/** A 2GIS discovery of this handle inside an Almaty mall. */
const almatyGisCandidate = () => [
  { sourceMeta: { gisUrl: "https://2gis.kz/almaty/firm/70000001040978314" } },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  boutique.findUnique.mockResolvedValue(null);
  importJob.update.mockResolvedValue({ id: "job-1" });
  boutique.updateMany.mockResolvedValue({ count: 1 });
  discoveryCandidate.findMany.mockResolvedValue([]);
});

describe("boutique city", () => {
  /**
   * REGRESSION — a store found through 2GIS has a known address, but that
   * knowledge stayed on the discovery candidate: all seventy-nine 2GIS
   * boutiques had an empty city and had to be confirmed by hand.
   */
  it("takes the city from the 2GIS venue the store was discovered in", async () => {
    importJob.findUniqueOrThrow.mockResolvedValue(readyJob(preview()));
    discoveryCandidate.findMany.mockResolvedValue(almatyGisCandidate());
    boutique.upsert.mockImplementation(({ create }: { create: { city: string | null } }) => ({
      id: "b1",
      city: create.city,
    }));

    await runPersist("job-1");

    const create = boutique.upsert.mock.calls[0]![0].create;
    expect(create.city).toBe("Алматы");
    expect(create.country).toBe("Kazakhstan");
  });

  /**
   * REGRESSION — the boutique is created at Parse, before any AI runs, and
   * location was written on CREATE only. So the AI's city, arriving later as an
   * UPDATE, never landed: forty boutiques carried "Алматы" in their analysis
   * and an empty city column.
   */
  it("fills an EMPTY city on an existing boutique", async () => {
    importJob.findUniqueOrThrow.mockResolvedValue(
      readyJob(preview({ aiResult: { city: "Алматы" } })),
    );
    // The boutique already exists, with no city.
    boutique.upsert.mockResolvedValue({ id: "b1", city: null });

    await runPersist("job-1");

    expect(boutique.updateMany).toHaveBeenCalledWith({
      where: { id: "b1", city: null },
      data: { city: "Алматы", region: null, country: "Kazakhstan" },
    });
  });

  it("NEVER replaces a city that is already there — a manual correction survives", async () => {
    importJob.findUniqueOrThrow.mockResolvedValue(
      readyJob(preview({ aiResult: { city: "Алматы" } })),
    );
    // Corrected by hand to Astana; the AI's Almaty must not overwrite it.
    boutique.upsert.mockResolvedValue({ id: "b1", city: "Астана" });

    await runPersist("job-1");

    expect(boutique.updateMany).not.toHaveBeenCalled();
  });

  it("guards the fill in the database too, so a concurrent correction still wins", async () => {
    importJob.findUniqueOrThrow.mockResolvedValue(
      readyJob(preview({ aiResult: { city: "Алматы" } })),
    );
    boutique.upsert.mockResolvedValue({ id: "b1", city: null });

    await runPersist("job-1");

    // The write is conditional on the column still being empty.
    const where = boutique.updateMany.mock.calls[0]![0].where;
    expect(where).toEqual({ id: "b1", city: null });
  });

  it("writes nothing when no source knows the city", async () => {
    importJob.findUniqueOrThrow.mockResolvedValue(readyJob(preview()));
    boutique.upsert.mockResolvedValue({ id: "b1", city: null });

    await runPersist("job-1");

    expect(boutique.updateMany).not.toHaveBeenCalled();
  });

  it("does not invent Almaty for a shop the AI places elsewhere", async () => {
    // A Shymkent store must stay Shymkent, and so stay off the Almaty channel.
    importJob.findUniqueOrThrow.mockResolvedValue(
      readyJob(preview({ aiResult: { city: "Шымкент" } })),
    );
    boutique.upsert.mockResolvedValue({ id: "b1", city: null });

    await runPersist("job-1");

    expect(boutique.updateMany.mock.calls[0]![0].data.city).toBe("Шымкент");
  });
});
