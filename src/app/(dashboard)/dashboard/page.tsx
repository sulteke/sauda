import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { DashboardStats } from "@/features/dashboard/components/dashboard-stats";
import { getDashboardStats } from "@/services/dashboard.service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default async function DashboardPage() {
  const stats = await getDashboardStats();

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description="Overview of boutiques and the review pipeline." />
      <DashboardStats stats={stats} />
    </div>
  );
}
