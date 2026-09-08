import type { ReactNode } from "react";
import {
  Clock,
  Globe,
  Link2,
  Map,
  MapPin,
  MessageCircle,
  Phone,
  Send,
  Truck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { BoutiqueEnrichment } from "@/types";

/** True when the enrichment carries at least one piece of business information. */
export function hasEnrichmentData(e: BoutiqueEnrichment): boolean {
  return (
    e.phones.length > 0 ||
    e.whatsapp.length > 0 ||
    e.telegram.length > 0 ||
    e.twoGis.length > 0 ||
    e.googleMaps.length > 0 ||
    Boolean(e.website) ||
    Boolean(e.taplink) ||
    Boolean(e.city) ||
    Boolean(e.address) ||
    e.deliveryRegions.length > 0 ||
    Boolean(e.businessHours)
  );
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function tgHref(ref: string): string {
  return ref.startsWith("@") ? `https://t.me/${ref.slice(1)}` : ref;
}

function Row({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm">{children}</div>
      </div>
    </div>
  );
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-primary hover:underline"
    >
      {children}
    </a>
  );
}

/**
 * Renders the structured business information derived at import time. Only fields
 * that carry data are shown; renders nothing when the enrichment is empty.
 */
export function BusinessInfo({ enrichment: e }: { enrichment: BoutiqueEnrichment }) {
  if (!hasEnrichmentData(e)) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {e.phones.length > 0 ? (
        <Row icon={Phone} label="Phone">
          {e.phones.map((p) => (
            <a key={p} href={`tel:${p}`} className="text-primary hover:underline">
              {p}
            </a>
          ))}
        </Row>
      ) : null}

      {e.whatsapp.length > 0 ? (
        <Row icon={MessageCircle} label="WhatsApp">
          {e.whatsapp.map((w) => (
            <ExtLink key={w} href={w}>
              {shortUrl(w)}
            </ExtLink>
          ))}
        </Row>
      ) : null}

      {e.telegram.length > 0 ? (
        <Row icon={Send} label="Telegram">
          {e.telegram.map((t) => (
            <ExtLink key={t} href={tgHref(t)}>
              {t}
            </ExtLink>
          ))}
        </Row>
      ) : null}

      {e.city || e.address ? (
        <Row icon={MapPin} label="Location">
          {[e.address, e.city].filter(Boolean).join(", ")}
        </Row>
      ) : null}

      {e.businessHours ? (
        <Row icon={Clock} label="Hours">
          {e.businessHours}
        </Row>
      ) : null}

      {e.deliveryRegions.length > 0 ? (
        <Row icon={Truck} label="Delivery">
          {e.deliveryRegions.join(", ")}
        </Row>
      ) : null}

      {e.website ? (
        <Row icon={Globe} label="Website">
          <ExtLink href={e.website}>{shortUrl(e.website)}</ExtLink>
        </Row>
      ) : null}

      {e.taplink ? (
        <Row icon={Link2} label="Taplink">
          <ExtLink href={e.taplink}>{shortUrl(e.taplink)}</ExtLink>
        </Row>
      ) : null}

      {e.twoGis.length > 0 ? (
        <Row icon={Map} label="2GIS">
          {e.twoGis.map((u) => (
            <ExtLink key={u} href={u}>
              {shortUrl(u)}
            </ExtLink>
          ))}
        </Row>
      ) : null}

      {e.googleMaps.length > 0 ? (
        <Row icon={Map} label="Google Maps">
          {e.googleMaps.map((u) => (
            <ExtLink key={u} href={u}>
              {shortUrl(u)}
            </ExtLink>
          ))}
        </Row>
      ) : null}
    </div>
  );
}
