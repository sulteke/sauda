import { GisLocationError, type GisLocation } from "./gis-store-source";

/**
 * Parses the admin's venue input into a 2GIS location.
 *
 * Accepted forms:
 *   - a bare numeric id            → "9430047375099302"          (building)
 *   - a 2GIS "inside" URL          → 2gis.kz/almaty/inside/<id>  (building)
 *   - a 2GIS geo/place URL         → 2gis.kz/almaty/geo/<id>     (place)
 *   - an explicit prefix           → "building:<id>" / "place:<id>"
 *
 * A firm URL (2gis.kz/almaty/firm/<id>) is deliberately REJECTED with guidance:
 * a firm id identifies one business, not the venue, so enumerating it would
 * silently return a single store instead of the mall the admin meant.
 */
export function parseGisLocation(input: string, name?: string | null): GisLocation {
  const trimmed = input.trim();
  if (!trimmed) throw new GisLocationError("Enter a 2GIS location URL or building id.");

  const prefixed = /^(building|place)\s*:\s*(\d{6,})$/i.exec(trimmed);
  if (prefixed?.[1] && prefixed[2]) {
    return { kind: prefixed[1].toLowerCase() as "building" | "place", id: prefixed[2], name };
  }

  if (/^\d{6,}$/.test(trimmed)) return { kind: "building", id: trimmed, name };

  let url: URL | null = null;
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    url = null;
  }

  if (url && /(^|\.)2gis\.[a-z.]+$/i.test(url.hostname)) {
    const segments = url.pathname.split("/").filter(Boolean);
    const kindIndex = segments.findIndex((segment) =>
      ["inside", "geo", "building", "firm"].includes(segment),
    );
    const kind = kindIndex >= 0 ? segments[kindIndex] : null;
    const id = kindIndex >= 0 ? segments[kindIndex + 1] : null;

    if (kind === "firm") {
      throw new GisLocationError(
        "That is a single business (firm) link, not a venue. Open the building on 2GIS and use its /inside/<id> link.",
      );
    }
    if (id && /^\d{6,}$/.test(id)) {
      return { kind: kind === "geo" ? "place" : "building", id, name };
    }
  }

  throw new GisLocationError(
    "Could not read a 2GIS location. Paste a 2gis.kz/.../inside/<id> link or the numeric building id.",
  );
}
