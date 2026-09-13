import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { PublishQueueButton } from "@/features/telegram/components/publish-queue-button";
import { TelegramBoard } from "@/features/telegram/components/telegram-board";
import { listBoutiquesByTelegramStatus } from "@/services/boutique.service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Telegram",
};

export default async function TelegramPage() {
  // Telegram state is independent of approval — all of these are APPROVED
  // boutiques grouped by what the publisher did (or will do) with them.
  const [pending, published, skipped, failed] = await Promise.all([
    listBoutiquesByTelegramStatus("PENDING"),
    listBoutiquesByTelegramStatus("PUBLISHED"),
    listBoutiquesByTelegramStatus("SKIPPED"),
    listBoutiquesByTelegramStatus("FAILED"),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Telegram"
        description="Publish approved Almaty boutiques to your Telegram channel. Approval is separate — every accepted boutique stays approved regardless of city."
      >
        <PublishQueueButton pending={pending.length} />
      </PageHeader>
      <TelegramBoard pending={pending} published={published} skipped={skipped} failed={failed} />
    </div>
  );
}
