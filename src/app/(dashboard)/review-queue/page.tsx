import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { ReviewQueueTable } from "@/features/review/components/review-queue-table";
import { listReviewQueue } from "@/services/boutique.service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Review Queue",
};

export default async function ReviewQueuePage() {
  const items = await listReviewQueue();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Review Queue"
        description="Approve or reject imported boutiques before publishing."
      />
      <ReviewQueueTable items={items} />
    </div>
  );
}
