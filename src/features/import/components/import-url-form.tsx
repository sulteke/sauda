"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { importUrlSchema, type ImportUrlInput } from "@/features/import/schemas";

interface ImportUrlFormProps {
  onAnalyze: (url: string) => void | Promise<void>;
  isPending?: boolean;
}

export function ImportUrlForm({ onAnalyze, isPending = false }: ImportUrlFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ImportUrlInput>({
    resolver: zodResolver(importUrlSchema),
    defaultValues: { url: "" },
  });

  return (
    <form onSubmit={handleSubmit((values) => onAnalyze(values.url))} className="space-y-2">
      <Label htmlFor="url">Instagram Profile URL</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="url"
          placeholder="https://instagram.com/almaty.boutique"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={isPending}
          {...register("url")}
        />
        <Button type="submit" disabled={isPending} className="sm:w-32">
          {isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Analyzing
            </>
          ) : (
            "Analyze"
          )}
        </Button>
      </div>
      {errors.url ? <p className="text-sm text-destructive">{errors.url.message}</p> : null}
    </form>
  );
}
