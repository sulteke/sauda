import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AddToQueueForm } from "@/features/queue/components/add-to-queue-form";
import { ProcessQueueButton } from "@/features/queue/components/process-queue-button";
import { QueueTable } from "@/features/queue/components/queue-table";

export const metadata: Metadata = {
  title: "Import Queue",
};

export default function QueuePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Import Queue"
        description="Bulk-import boutiques from Instagram URLs — no manual pasting one by one."
      >
        <ProcessQueueButton />
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Add URLs</CardTitle>
          <CardDescription>Paste Instagram profile URLs, one per line.</CardDescription>
        </CardHeader>
        <CardContent>
          <AddToQueueForm />
        </CardContent>
      </Card>

      <QueueTable />
    </div>
  );
}
