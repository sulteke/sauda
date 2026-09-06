import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CandidateTable } from "@/features/discovery/components/candidate-table";
import { DiscoveryForm } from "@/features/discovery/components/discovery-form";

export const metadata: Metadata = {
  title: "Discovery",
};

export default function DiscoveryPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Discovery"
        description="Find candidate boutique accounts from a profile or hashtag, then queue the good ones."
      />

      <Card>
        <CardHeader>
          <CardTitle>Discover accounts</CardTitle>
          <CardDescription>
            Enter one Instagram profile (@handle or URL) or one #hashtag.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DiscoveryForm />
        </CardContent>
      </Card>

      <CandidateTable />
    </div>
  );
}
