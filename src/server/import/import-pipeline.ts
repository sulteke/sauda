import "server-only";

import { Prisma, type ImportJob } from "@prisma/client";

import { analyzeCategories } from "@/lib/category-analyzer";
import { prisma } from "@/lib/prisma";
import type { BoutiquePreview, ImportJobDTO } from "@/types";
import { slugify } from "@/utils/format";

import { ImportStateError } from "./errors";
import { getInstagramProvider } from "./instagram-provider";
import type { RawInstagramProfile } from "./provider-types";

/** Normalizes a raw provider profile into a boutique draft. */
export function mapProfileToPreview(profile: RawInstagramProfile): BoutiquePreview {
  // Auto-detect product categories from the boutique's own text. This replaces
  // Instagram's `businessCategoryName` (still available in the raw payload) as
  // the boutique's category. The primary (highest-scoring) label doubles as the
  // single `category` value so existing single-category surfaces keep working.
  const detected = analyzeCategories({
    biography: profile.biography,
    posts: profile.recentPosts.map((post) => ({
      caption: post.caption,
      hashtags: post.hashtags,
      mentions: post.mentions,
    })),
  });
  const productCategories = detected.map(({ id, label }) => ({ id, label }));

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
    city: null,
    recentPosts: profile.recentPosts.slice(0, 6),
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
 */
export async function runDiscovery(jobId: string): Promise<ImportJob> {
  await prisma.importJob.update({
    where: { id: jobId },
    data: { status: "PROCESSING", attempts: { increment: 1 } },
  });

  const job = await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });

  try {
    const provider = getInstagramProvider();
    const profile = await provider.fetchProfile({
      url: job.sourceUrl,
      handle: job.handle ?? "",
    });
    const preview = mapProfileToPreview(profile);

    return await prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: "READY_FOR_REVIEW",
        rawProfile: profile as unknown as Prisma.InputJsonValue,
        preview: preview as unknown as Prisma.InputJsonValue,
        error: null,
      },
    });
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
 * Stage 2 — persist. Turns a reviewed preview into a Boutique. Idempotent by
 * Instagram handle: re-importing the same profile links to the existing boutique
 * instead of creating a duplicate (critical at 100k+ scale).
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

  const boutique = await prisma.boutique.upsert({
    where: { instagramHandle: preview.instagramHandle },
    // Re-import refreshes ONLY the imported/enrichment fields. Manually-owned
    // fields (name, city, status, description) are never overwritten.
    update: {
      avatarUrl: preview.avatarUrl,
      bio: preview.description,
      category: preview.category,
      productCategories: (preview.productCategories ?? []).map((c) => c.id),
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
      updatedAt: new Date(),
    },
    create: {
      name: preview.name,
      slug: preview.slug,
      description: preview.description,
      city: preview.city,
      status: "DRAFT",
      instagramHandle: preview.instagramHandle,
      instagramUrl: preview.instagramUrl,
      avatarUrl: preview.avatarUrl,
      bio: preview.description,
      category: preview.category,
      productCategories: (preview.productCategories ?? []).map((c) => c.id),
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
    },
  });

  const updated = await prisma.importJob.update({
    where: { id: jobId },
    data: { status: "COMPLETED", boutiqueId: boutique.id },
  });

  return { job: updated, boutiqueId: boutique.id };
}
