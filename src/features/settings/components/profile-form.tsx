"use client";

import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

const profileSchema = z.object({
  displayName: z.string().min(2, "Name is too short").max(60, "Name is too long"),
});

type ProfileInput = z.infer<typeof profileSchema>;

interface ProfileFormProps {
  email: string;
  initialName: string;
}

export function ProfileForm({ email, initialName }: ProfileFormProps) {
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ProfileInput>({
    resolver: zodResolver(profileSchema),
    defaultValues: { displayName: initialName },
  });

  async function onSubmit(values: ProfileInput) {
    setStatus("idle");
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({
      data: { display_name: values.displayName },
    });
    setStatus(error ? "error" : "success");
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-md space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" value={email} disabled readOnly />
      </div>

      <div className="space-y-2">
        <Label htmlFor="displayName">Display name</Label>
        <Input id="displayName" {...register("displayName")} />
        {errors.displayName ? (
          <p className="text-sm text-destructive">{errors.displayName.message}</p>
        ) : null}
      </div>

      {status === "success" ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">Profile updated.</p>
      ) : null}
      {status === "error" ? (
        <p className="text-sm text-destructive">Could not update profile. Please try again.</p>
      ) : null}

      <Button type="submit" disabled={isSubmitting}>
        Save changes
      </Button>
    </form>
  );
}
