import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ProfileForm } from "@/features/settings/components/profile-form";
import { getCurrentUser } from "@/server/auth";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function SettingsPage() {
  const user = await getCurrentUser();
  const email = user?.email ?? "";
  const displayName = user?.user_metadata?.display_name;
  const initialName = typeof displayName === "string" ? displayName : "";

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Manage your admin profile." />
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Update the name shown across the admin system.</CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileForm email={email} initialName={initialName} />
        </CardContent>
      </Card>
    </div>
  );
}
