"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { ImportPreview } from "@/features/import/components/import-preview";
import { ImportUrlForm } from "@/features/import/components/import-url-form";
import { useAnalyzeImport, useSaveImport } from "@/hooks/use-import";
import type { ImportJobDTO } from "@/types";

export function ImportCenter() {
  const [job, setJob] = useState<ImportJobDTO | null>(null);
  const analyze = useAnalyzeImport();
  const save = useSaveImport();

  async function handleAnalyze(url: string) {
    try {
      const result = await analyze.mutateAsync(url);
      setJob(result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to analyze profile");
    }
  }

  async function handleSave() {
    if (!job) return;
    try {
      const result = await save.mutateAsync(job.id);
      setJob(result.job);
      toast.success("Boutique saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save boutique");
    }
  }

  function handleReset() {
    setJob(null);
  }

  return (
    <div className="max-w-2xl space-y-6">
      <Card>
        <CardContent className="pt-6">
          <ImportUrlForm onAnalyze={handleAnalyze} isPending={analyze.isPending} />
        </CardContent>
      </Card>

      {job ? (
        <ImportPreview
          job={job}
          onSave={handleSave}
          onReset={handleReset}
          isSaving={save.isPending}
        />
      ) : null}
    </div>
  );
}
