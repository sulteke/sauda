import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { ImportCenter } from "@/features/import/components/import-center";

export const metadata: Metadata = {
  title: "Import",
};

export default function ImportPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Import Center"
        description="Discover a boutique automatically from its Instagram profile."
      />
      <ImportCenter />
    </div>
  );
}
