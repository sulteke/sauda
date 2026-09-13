import type { PublicationTarget, PublishableBoutique } from "./publication-target";

/** Result of attempting one target for one boutique. */
export type PublicationStatus = "PUBLISHED" | "SKIPPED" | "FAILED";

/** Per-target outcome, the generic currency the engine produces. */
export interface PublicationOutcome {
  targetId: string;
  label: string;
  status: PublicationStatus;
  error: string | null;
}

/**
 * Target-driven publication engine. Runs each registered target against the
 * boutique — eligibility gate → publish → outcome — and returns one
 * {@link PublicationOutcome} per target.
 *
 * It is completely destination-agnostic: it knows nothing about Telegram, the
 * website, storage, or the approval workflow. Targets own all destination logic;
 * the engine only executes them and reports results. It never throws — a target
 * that fails becomes a FAILED outcome so the remaining targets still run and the
 * caller can record every result independently.
 *
 * This shape is what makes multiple targets (more Telegram channels, Website,
 * Instagram, WhatsApp, Email) possible without touching the engine: register a
 * target, and its outcome flows through here like any other.
 */
export async function publishToTargets(
  boutique: PublishableBoutique,
  targets: PublicationTarget[],
): Promise<PublicationOutcome[]> {
  const outcomes: PublicationOutcome[] = [];

  for (const target of targets) {
    if (!target.isEligible(boutique)) {
      outcomes.push({ targetId: target.id, label: target.label, status: "SKIPPED", error: null });
      continue;
    }

    try {
      await target.publish(boutique);
      outcomes.push({ targetId: target.id, label: target.label, status: "PUBLISHED", error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Publish failed";
      outcomes.push({ targetId: target.id, label: target.label, status: "FAILED", error: message });
    }
  }

  return outcomes;
}
