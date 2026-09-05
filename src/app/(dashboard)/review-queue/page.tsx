import type { Metadata } from "next";
import { ClipboardCheck } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";

export const metadata: Metadata = {
  title: "Review Queue",
};

export default function ReviewQueuePage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Review Queue" description="Boutiques awaiting admin review." />
      <EmptyState
        icon={ClipboardCheck}
        title="Nothing to review"
        description="Boutiques marked as Needs Review will appear here."
      />
    </div>
  );
}
