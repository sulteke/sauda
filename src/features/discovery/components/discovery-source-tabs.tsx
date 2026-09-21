"use client";

import { useState } from "react";
import { Hash, MapPin } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DiscoveryForm } from "@/features/discovery/components/discovery-form";
import { GisDiscoveryForm } from "@/features/discovery/components/gis-discovery-form";

type Source = "instagram" | "gis";

/**
 * Picks the discovery source. The two are genuinely different starting points —
 * Instagram hashtags search accounts directly, while 2GIS starts from a physical
 * venue and works outward to the accounts — so they get separate forms rather
 * than one overloaded input.
 *
 * Implemented as a plain toggle instead of a Tabs primitive to avoid adding a
 * dependency for two options.
 */
export function DiscoverySourceTabs() {
  const [source, setSource] = useState<Source>("instagram");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={source === "instagram" ? "default" : "outline"}
          size="sm"
          onClick={() => setSource("instagram")}
        >
          <Hash className="h-4 w-4" />
          Instagram Hashtags
        </Button>
        <Button
          type="button"
          variant={source === "gis" ? "default" : "outline"}
          size="sm"
          onClick={() => setSource("gis")}
        >
          <MapPin className="h-4 w-4" />
          2GIS Location
        </Button>
      </div>

      {source === "instagram" ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Enter one Instagram profile (@handle or URL) or one #hashtag.
          </p>
          <DiscoveryForm />
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Enter a 2GIS venue — paste a share link straight from the 2GIS app, a
            2gis.kz/…/inside/&lt;id&gt; link, or a building id. A link to a single business is
            resolved to the building it sits in. Every business inside is enumerated, filtered to
            fashion retail, and those with a findable Instagram account become candidates.
          </p>
          <GisDiscoveryForm />
        </div>
      )}
    </div>
  );
}
