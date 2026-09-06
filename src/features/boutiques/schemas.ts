import { z } from "zod";

import type { BoutiqueStatus } from "@/types";

export const BOUTIQUE_STATUSES = [
  "DRAFT",
  "NEEDS_REVIEW",
  "PUBLISHED",
  "ARCHIVED",
] as const satisfies readonly BoutiqueStatus[];

export const BOUTIQUE_STATUS_LABELS: Record<BoutiqueStatus, string> = {
  DRAFT: "Draft",
  NEEDS_REVIEW: "Needs review",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

/** Input accepted when creating or editing a boutique. */
export const boutiqueInputSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(120),
  slug: z.string().trim().max(140).optional(),
  city: z.string().trim().max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  status: z.enum(BOUTIQUE_STATUSES),
  telegramQueued: z.boolean(),
});

export type BoutiqueInput = z.infer<typeof boutiqueInputSchema>;

/** Partial variant used by PATCH updates. */
export const boutiqueUpdateSchema = boutiqueInputSchema.partial();

export type BoutiqueUpdate = z.infer<typeof boutiqueUpdateSchema>;
