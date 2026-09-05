import { CheckCircle2, ClipboardCheck, Send, Store } from "lucide-react";

import { StatCard } from "@/components/shared/stat-card";
import type { DashboardStats as Stats } from "@/types";

interface DashboardStatsProps {
  stats: Stats;
}

export function DashboardStats({ stats }: DashboardStatsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Total Boutiques"
        value={stats.totalBoutiques}
        icon={Store}
        description="All boutiques in the system"
      />
      <StatCard
        title="Need Review"
        value={stats.needReview}
        icon={ClipboardCheck}
        description="Awaiting admin review"
      />
      <StatCard
        title="Published"
        value={stats.published}
        icon={CheckCircle2}
        description="Live boutiques"
      />
      <StatCard
        title="Telegram Queue"
        value={stats.telegramQueue}
        icon={Send}
        description="Queued to publish"
      />
    </div>
  );
}
