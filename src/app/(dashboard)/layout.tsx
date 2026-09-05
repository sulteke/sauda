import type { ReactNode } from "react";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { TopNavbar } from "@/components/layout/top-navbar";
import { requireUser } from "@/server/auth";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Defense in depth: middleware already guards these routes.
  const user = await requireUser();
  const email = user.email ?? "admin";

  return (
    <div className="flex min-h-screen">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopNavbar email={email} />
        <main className="flex-1 space-y-6 p-4 md:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
