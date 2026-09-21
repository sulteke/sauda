"use client";

import { useState, type FormEvent } from "react";
import { MapPin } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The venue used to verify the integration end-to-end before a wider run. */
const APORT_WEST = { name: "Aport Mall West", id: "9430047375099302" };
/** Small cap for a first pass, so a new venue is verified cheaply. */
const DEFAULT_TEST_LIMIT = 50;

interface GisResult {
  locationId: string;
  locationName: string | null;
  source: string;
  usedFallback: boolean;
  storesFound: number;
  relevantStores: number;
  filteredOut: number;
  instagramFound: number;
  alreadyKnown: number;
  noInstagram: number;
  newCandidates: number;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/**
 * Location-first discovery: enter a 2GIS venue, get discovery candidates.
 *
 * It creates candidates only — importing and analysing them stays with the
 * existing Auto Import controls, so a large venue can never trigger a large
 * AI run by itself.
 */
export function GisDiscoveryForm() {
  const [location, setLocation] = useState("");
  const [limit, setLimit] = useState(String(DEFAULT_TEST_LIMIT));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<GisResult | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = location.trim();
    if (!value) return;

    setRunning(true);
    try {
      const parsedLimit = Number(limit);
      const res = await fetch("/api/discovery/gis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: value,
          ...(Number.isFinite(parsedLimit) && parsedLimit > 0 ? { limit: parsedLimit } : {}),
          ...(value === APORT_WEST.id ? { locationName: APORT_WEST.name } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { data?: GisResult; error?: string };
      if (!res.ok || !json.data) throw new Error(json.error ?? "2GIS discovery failed");

      setResult(json.data);
      toast.success(
        `${json.data.storesFound} stores · ${json.data.newCandidates} new candidate${json.data.newCandidates === 1 ? "" : "s"}`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "2GIS discovery failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="go.2gis.com/… share link, 2gis.kz/…/inside/<id>, or a building id"
            className="sm:flex-1"
          />
          <div className="flex items-center gap-2">
            <Label htmlFor="gis-limit" className="whitespace-nowrap text-xs text-muted-foreground">
              Max stores
            </Label>
            <Input
              id="gis-limit"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              className="w-24"
              inputMode="numeric"
            />
          </div>
          <Button type="submit" disabled={running || !location.trim()}>
            <MapPin className="h-4 w-4" />
            {running ? "Finding stores..." : "Find stores"}
          </Button>
        </div>
        <button
          type="button"
          onClick={() => setLocation(APORT_WEST.id)}
          className="text-xs text-primary hover:underline"
        >
          Use {APORT_WEST.name} ({APORT_WEST.id})
        </button>
      </form>

      {result ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="2GIS stores found" value={result.storesFound} />
            <Stat label="Fashion stores" value={result.relevantStores} />
            <Stat label="Instagram found" value={result.instagramFound} />
            <Stat label="Already known" value={result.alreadyKnown} />
            <Stat label="No Instagram" value={result.noInstagram} />
            <Stat label="New candidates" value={result.newCandidates} />
          </div>
          <p className="text-xs text-muted-foreground">
            Source: {result.source}
            {result.usedFallback ? " (Apify fallback)" : ""} · {result.filteredOut} non-fashion
            businesses filtered out · candidates are NOT analyzed until you run Auto Import.
          </p>
        </div>
      ) : null}
    </div>
  );
}
