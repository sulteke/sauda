import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AutoImportPanel } from "@/features/discovery/components/auto-import-panel";
import { CandidateTable } from "@/features/discovery/components/candidate-table";
import { DiscoverySourceTabs } from "@/features/discovery/components/discovery-source-tabs";

export const metadata: Metadata = {
  title: "Discovery",
};

export default function DiscoveryPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Discovery"
        description="Find candidate boutique accounts from a hashtag, a profile, or a 2GIS location, then queue the good ones."
      />

      <Card>
        <CardHeader>
          <CardTitle>Discover accounts</CardTitle>
          <CardDescription>
            Search Instagram directly, or start from a physical 2GIS location.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DiscoverySourceTabs />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Import candidates</CardTitle>
          <CardDescription>
            Send discovered accounts to the import queue in controlled batches of{" "}
            {/* keep Apify usage bounded */}10 — one click imports them all, batch by batch.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AutoImportPanel />
        </CardContent>
      </Card>

      <CandidateTable />
    </div>
  );
}
