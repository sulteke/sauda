import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { BoutiquesTable } from "@/features/boutiques/components/boutiques-table";

export const metadata: Metadata = {
  title: "Boutiques",
};

export default function BoutiquesPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Boutiques" description="All boutiques managed in the system." />
      <BoutiquesTable />
    </div>
  );
}
