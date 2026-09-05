import type { Metadata } from "next";
import { Send } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";

export const metadata: Metadata = {
  title: "Telegram",
};

export default function TelegramPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Telegram" description="Queue of boutiques to publish to Telegram." />
      <EmptyState
        icon={Send}
        title="Telegram integration not connected"
        description="This foundation reserves the Telegram queue but does not send messages yet."
      />
    </div>
  );
}
