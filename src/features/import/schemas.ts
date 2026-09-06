import { z } from "zod";

/** The only manual input in the whole product: an Instagram profile URL. */
export const importUrlSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, "Instagram profile URL is required")
    .refine((value) => /instagram\.com/i.test(value), "Enter a valid Instagram profile URL"),
});

export type ImportUrlInput = z.infer<typeof importUrlSchema>;
