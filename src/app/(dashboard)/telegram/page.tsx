import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { PublishQueueButton } from "@/features/telegram/components/publish-queue-button";
import { TelegramBoard } from "@/features/telegram/components/telegram-board";
import { listBoutiquesByStatus } from "@/services/boutique.service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Telegram",
};

export default async function TelegramPage() {
  const [pending, published, failed] = await Promise.all([
    listBoutiquesByStatus(["READY_TO_PUBLISH"]),
    listBoutiquesByStatus(["PUBLISHED"]),
    listBoutiquesByStatus(["TELEGRAM_FAILED"]),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Telegram"
        description="Publish approved boutiques to your Telegram channel."
      >
        <PublishQueueButton pending={pending.length} />
      </PageHeader>
      <TelegramBoard pending={pending} published={published} failed={failed} />
    </div>
  );
}
