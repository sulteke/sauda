"use client";

import { useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRunDiscovery } from "@/hooks/use-discovery";

export function DiscoveryForm() {
  const [seed, setSeed] = useState("");
  const run = useRunDiscovery();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!seed.trim()) return;

    try {
      const result = await run.mutateAsync(seed.trim());
      toast.success(
        `Found ${result.found} candidate${result.found === 1 ? "" : "s"} (${result.added} new)`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Discovery failed");
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
      <Input
        value={seed}
        onChange={(event) => setSeed(event.target.value)}
        placeholder="@baraholka_almaty or #almaty"
      />
      <Button type="submit" disabled={run.isPending || !seed.trim()}>
        <Search className="h-4 w-4" />
        {run.isPending ? "Discovering..." : "Discover"}
      </Button>
    </form>
  );
}
