import "server-only";

import { type Boutique, Prisma, type ImportJob } from "@prisma/client";

import { disabledAiCategoryProvider } from "@/lib/ai-category-provider";
import { enrichBoutique } from "@/lib/boutique-enrichment";
import {
  type CategoryDetectionInput,
  EMPTY_OVERRIDES,
  type HybridDetectionResult,
  mergeCategories,
  runHybridDetection,
} from "@/lib/category-pipeline";
import { resolveLocation } from "@/lib/location";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { assertAiInvocationAllowed, reserveAiInvocation } from "@/server/ai/analysis-budget";
import { resolveAiCategoryProvider } from "@/server/ai/gemini-category-provider";
import type { BoutiqueEnrichment, BoutiquePreview, ImportJobDTO } from "@/types";
import { slugify } from "@/utils/format";

import { ImportStateError } from "./errors";
import { getInstagramProvider } from "./instagram-provider";
import { MAX_RECENT_POSTS } from "./provider-types";
import type { RawInstagramProfile } from "./provider-types";

/** Builds the category-pipeline input (text + media + AI context) from a profile. */
function toDetectionInput(profile: RawInstagramProfile): CategoryDetectionInput {
  return {
    biography: profile.biography,
    avatarUrl: profile.profilePicUrl,
    posts: profile.recentPosts.map((post) => ({
      caption: post.caption,
      hashtags: post.hashtags,
      mentions: post.mentions,
      imageUrl: post.imageUrl,
    })),
    businessName: profile.fullName,
    username: profile.handle,
    externalUrl: profile.externalUrl,
    externalUrls: profile.externalUrls,
    businessAddress: profile.businessAddress,
  };
}

/**
 * Normalizes a raw provider profile into a boutique draft. Hybrid detection
 * (keyword → AI) is done upstream and passed in as `detection`; the merged
 * auto-detected list drives `category`/`productCategories`/`categoryScores`,
 * while the keyword-only result and the raw AI result are kept SEPARATELY
 * (keywordScores, aiResult) so we always know each stage's output. Manual
 * overrides (Stage 3) are applied later, at persist time.
 */
export function mapProfileToPreview(
  profile: RawInstagramProfile,
  detection: HybridDetectionResult,
  enrichment: BoutiqueEnrichment,
  aiRan: boolean,
): BoutiquePreview {
  const productCategories = detection.autoDetected.map(({ id, label }) => ({ id, label }));

  return {
    name: profile.fullName?.trim() || profile.handle,
    slug: slugify(profile.handle),
    description: profile.biography,
    instagramHandle: profile.handle,
    instagramUrl: profile.sourceUrl,
    avatarUrl: profile.profilePicUrl,
    externalUrl: profile.externalUrl,
    followersCount: profile.followersCount,
    isVerified: profile.isVerified,
    category: productCategories[0]?.label ?? null,
    productCategories,
    categoryScores: detection.autoDetected,
    keywordScores: detection.keyword,
    // Persist the AI result only when a real provider ran; null means "no AI".
    aiResult: aiRan ? detection.ai : undefined,
    enrichment,
    city: null,
    recentPosts: profile.recentPosts.slice(0, MAX_RECENT_POSTS),
    isBusinessAccount: profile.isBusinessAccount,
    isPrivate: profile.isPrivate,
    postsCount: profile.postsCount,
    followsCount: profile.followsCount,
    businessAddress: profile.businessAddress,
    externalUrls: profile.externalUrls,
    relatedProfiles: profile.relatedProfiles,
  };
}

/** Coerces an optional value into a Prisma Json input, mapping absent → SQL NULL. */
function jsonOrDbNull(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value == null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

export function toImportJobDTO(job: ImportJob): ImportJobDTO {
  return {
    id: job.id,
    source: job.source,
    sourceUrl: job.sourceUrl,
    handle: job.handle,
    status: job.status,
    preview: (job.preview as unknown as BoutiquePreview | null) ?? null,
    error: job.error,
    boutiqueId: job.boutiqueId,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

/**
 * Stage 1 — discovery. Moves the job PROCESSING, fetches the profile through the
 * configured provider, stores the raw payload + normalized preview, and lands in
 * READY_FOR_REVIEW (or FAILED). At scale this stage is what a background worker
 * runs; the status transitions are the contract.
 *
 * This is the manual single-import path, and it spends an AI request like any
 * other, so it is subject to the SAME daily budget. The check runs before the
 * job is touched or the profile scraped: a refused import must cost no Apify
 * credit and leave no half-finished row behind.
 */
export async function runDiscovery(jobId: string): Promise<ImportJob> {
  const aiProvider = resolveAiCategoryProvider();
  await assertAiInvocationAllowed(aiProvider.name, { jobId, path: "manual-import" });

  await prisma.importJob.update({
    where: { id: jobId },
    data: { status: "PROCESSING", attempts: { increment: 1 } },
  });

  const job = await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });

  try {
    const startedAt = Date.now();
    const provider = getInstagramProvider();
    const profile = await provider.fetchProfile({
      url: job.sourceUrl,
      handle: job.handle ?? "",
    });
    // Hybrid detection: Keyword Engine → Gemini AI (disabled unless GEMINI_API_KEY
    // is set). Enrichment is computed once and shared as AI context + persistence.
    const detectionInput = toDetectionInput(profile);
    const enrichment = enrichBoutique({
      biography: profile.biography,
      externalUrl: profile.externalUrl,
      externalUrls: profile.externalUrls,
      businessAddress: profile.businessAddress,
    });
    await reserveAiInvocation(jobId, aiProvider.name);
    const detection = await runHybridDetection(detectionInput, { aiProvider, enrichment });
    const preview = mapProfileToPreview(
      profile,
      detection,
      enrichment,
      aiProvider.name !== "disabled",
    );

    const updated = await prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: "READY_FOR_REVIEW",
        rawProfile: profile as unknown as Prisma.InputJsonValue,
        preview: preview as unknown as Prisma.InputJsonValue,
        error: null,
      },
    });

    // Total import (analyze) duration: fetch + detection + persist-to-job.
    logger.info("import.metrics", {
      handle: job.handle,
      totalMs: Date.now() - startedAt,
      postsCount: preview.recentPosts.length,
      aiProvider: aiProvider.name,
      status: "READY_FOR_REVIEW",
    });

    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Discovery failed";
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: "FAILED", error: message },
    });
    throw error;
  }
}

/**
 * Upserts a Boutique from a normalized preview. Idempotent by Instagram handle:
 * re-importing the same profile updates the existing boutique instead of
 * creating a duplicate (critical at 100k+ scale). Re-import refreshes ONLY the
 * imported/enrichment fields; manually-owned fields (name, city, status) and
 * manual category overrides (Stage 3) are never overwritten.
 *
 * `preserveExistingAiCategories` guards the two-stage flow: the keyword-only
 * Parse stage passes `true` so re-parsing a boutique that already has AI results
 * does NOT downgrade its categories/aiResult to keyword-only before Analyze
 * re-runs. Analyze (and the single-shot interactive persist) pass `false` and
 * write their authoritative categories.
 */
async function upsertBoutiqueFromPreview(
  preview: BoutiquePreview,
  opts: { preserveExistingAiCategories?: boolean } = {},
): Promise<Boutique> {
  // Merge the auto-detected categories with any manual admin overrides (Stage 3)
  // already stored for this handle, so admin corrections survive re-imports.
  const autoDetected = preview.categoryScores ?? [];
  const existing = await prisma.boutique.findUnique({
    where: { instagramHandle: preview.instagramHandle },
    select: { manualCategoriesAdded: true, manualCategoriesRemoved: true, aiResult: true },
  });
  const overrides = existing
    ? { added: existing.manualCategoriesAdded, removed: existing.manualCategoriesRemoved }
    : EMPTY_OVERRIDES;
  const merged = mergeCategories(autoDetected, overrides);
  const finalCategoryIds = merged.categories.map((c) => c.id);
  const primaryCategory = merged.categories[0]?.label ?? null;

  // When a keyword-only Parse re-runs on a boutique that already carries AI
  // results, keep the richer AI-merged categories until Analyze refreshes them.
  const keepExistingAi =
    Boolean(opts.preserveExistingAiCategories) && existing != null && existing.aiResult != null;

  // Fields always refreshed from the freshly parsed profile/posts.
  const profileData = {
    avatarUrl: preview.avatarUrl,
    bio: preview.description,
    keywordScores: (preview.keywordScores ?? []) as unknown as Prisma.InputJsonValue,
    enrichment: jsonOrDbNull(preview.enrichment),
    followersCount: preview.followersCount,
    externalUrl: preview.externalUrl,
    posts: (preview.recentPosts ?? []) as unknown as Prisma.InputJsonValue,
    isVerified: preview.isVerified,
    isBusinessAccount: preview.isBusinessAccount ?? null,
    isPrivate: preview.isPrivate ?? null,
    postsCount: preview.postsCount ?? null,
    followsCount: preview.followsCount ?? null,
    businessAddress: jsonOrDbNull(preview.businessAddress),
    externalUrls: (preview.externalUrls ?? []) as unknown as Prisma.InputJsonValue,
    relatedProfiles: (preview.relatedProfiles ?? []) as unknown as Prisma.InputJsonValue,
  };

  // AI-influenced category fields — skipped on update when we must keep existing AI.
  const categoryData = {
    category: primaryCategory,
    productCategories: finalCategoryIds,
    categoryScores: autoDetected as unknown as Prisma.InputJsonValue,
    aiResult: jsonOrDbNull(preview.aiResult),
  };

  // Location is derived from data we already have (enrichment city, AI city). It
  // is set on CREATE only; on UPDATE, city/region/country are left untouched so a
  // re-import never overwrites a manually-corrected location. Location NEVER
  // filters a boutique out — it only later gates Telegram publication.
  const location = resolveLocation({
    enrichmentCity: preview.enrichment?.city ?? null,
    aiCity: preview.aiResult?.city ?? null,
  });

  return prisma.boutique.upsert({
    where: { instagramHandle: preview.instagramHandle },
    update: { ...profileData, ...(keepExistingAi ? {} : categoryData), updatedAt: new Date() },
    create: {
      name: preview.name,
      slug: preview.slug,
      description: preview.description,
      city: location.city,
      region: location.region,
      country: location.country,
      status: "DRAFT",
      instagramHandle: preview.instagramHandle,
      instagramUrl: preview.instagramUrl,
      // A create never has existing AI to preserve.
      ...categoryData,
      ...profileData,
    },
  });
}

/**
 * Stage 2 (single-shot interactive path) — persist. Turns a reviewed preview
 * into a Boutique. Used by the admin's one-URL import flow; the bulk queue uses
 * the two-stage runParse/runAnalyze below.
 */
export async function runPersist(jobId: string): Promise<{ job: ImportJob; boutiqueId: string }> {
  const job = await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });

  if (job.status !== "READY_FOR_REVIEW") {
    throw new ImportStateError(`Import job is not ready to save (status: ${job.status}).`);
  }

  const preview = job.preview as unknown as BoutiquePreview | null;
  if (!preview) {
    throw new ImportStateError("Import job has no preview to save.");
  }

  const boutique = await upsertBoutiqueFromPreview(preview);

  const updated = await prisma.importJob.update({
    where: { id: jobId },
    data: { status: "COMPLETED", boutiqueId: boutique.id },
  });

  return { job: updated, boutiqueId: boutique.id };
}

/**
 * Two-stage queue — PARSE (Stage 1). Fetches the Instagram profile + recent
 * posts through the provider (Apify), runs KEYWORD-ONLY detection (no Gemini),
 * and persists everything: the raw payload + preview on the ImportJob and the
 * Boutique itself (idempotent by handle). Lands the ImportJob in
 * READY_FOR_REVIEW. Target runtime 20–40s. Apify failure → ImportJob FAILED
 * (rethrown so the queue records PARSE_FAILED); nothing here calls the AI.
 */
export async function runParse(jobId: string): Promise<{ job: ImportJob; boutiqueId: string }> {
  await prisma.importJob.update({
    where: { id: jobId },
    data: { status: "PROCESSING", attempts: { increment: 1 } },
  });

  const job = await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });

  try {
    const startedAt = Date.now();
    const provider = getInstagramProvider();
    const profile = await provider.fetchProfile({
      url: job.sourceUrl,
      handle: job.handle ?? "",
    });
    const enrichment = enrichBoutique({
      biography: profile.biography,
      externalUrl: profile.externalUrl,
      externalUrls: profile.externalUrls,
      businessAddress: profile.businessAddress,
    });
    // Keyword engine ONLY — the AI provider is disabled in the Parse stage.
    const detection = await runHybridDetection(toDetectionInput(profile), {
      aiProvider: disabledAiCategoryProvider,
      enrichment,
    });
    const preview = mapProfileToPreview(profile, detection, enrichment, false);

    const boutique = await upsertBoutiqueFromPreview(preview, {
      preserveExistingAiCategories: true,
    });

    const updated = await prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: "READY_FOR_REVIEW",
        rawProfile: profile as unknown as Prisma.InputJsonValue,
        preview: preview as unknown as Prisma.InputJsonValue,
        boutiqueId: boutique.id,
        error: null,
      },
    });

    logger.info("import.parse_metrics", {
      handle: job.handle,
      totalMs: Date.now() - startedAt,
      postsCount: preview.recentPosts.length,
      status: "PENDING_ANALYSIS",
    });

    return { job: updated, boutiqueId: boutique.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Parse failed";
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: "FAILED", error: message },
    });
    throw error;
  }
}

/**
 * Two-stage queue — ANALYZE (Stage 2). Loads the ALREADY-PARSED profile from the
 * ImportJob's stored raw payload (NO Apify call), runs Gemini category analysis
 * in strict mode, and writes the AI results + AI-merged categories onto the
 * Boutique. Lands the ImportJob in COMPLETED. Target runtime 5–20s. A Gemini
 * outage throws (strict mode) so the queue records ANALYSIS_FAILED and can retry
 * WITHOUT re-scraping; the Parse-stage Boutique stays intact because the upsert
 * only runs after a successful analysis.
 */
export async function runAnalyze(jobId: string): Promise<{ job: ImportJob; boutiqueId: string }> {
  const job = await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });

  const rawProfile = job.rawProfile as unknown as RawInstagramProfile | null;
  if (!rawProfile) {
    throw new ImportStateError("Import job has not been parsed yet (no raw profile to analyze).");
  }

  try {
    const startedAt = Date.now();
    const enrichment = enrichBoutique({
      biography: rawProfile.biography,
      externalUrl: rawProfile.externalUrl,
      externalUrls: rawProfile.externalUrls,
      businessAddress: rawProfile.businessAddress,
    });
    // Real AI provider in STRICT mode: a terminal Gemini failure throws so the
    // queue marks ANALYSIS_FAILED instead of silently degrading to keyword-only.
    const aiProvider = resolveAiCategoryProvider({ throwOnFailure: true });
    await reserveAiInvocation(jobId, aiProvider.name);
    const detection = await runHybridDetection(toDetectionInput(rawProfile), {
      aiProvider,
      enrichment,
    });
    const preview = mapProfileToPreview(
      rawProfile,
      detection,
      enrichment,
      aiProvider.name !== "disabled",
    );

    const boutique = await upsertBoutiqueFromPreview(preview);

    const updated = await prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: "COMPLETED",
        preview: preview as unknown as Prisma.InputJsonValue,
        boutiqueId: boutique.id,
        error: null,
      },
    });

    logger.info("import.analyze_metrics", {
      handle: job.handle,
      totalMs: Date.now() - startedAt,
      aiProvider: aiProvider.name,
      status: "READY_FOR_REVIEW",
    });

    return { job: updated, boutiqueId: boutique.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analysis failed";
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: "FAILED", error: message },
    });
    throw error;
  }
}
