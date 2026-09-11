import { Instagram } from "lucide-react";

interface InstagramLinkProps {
  /** The original, stored Instagram profile URL — used verbatim as the destination. */
  url: string | null | undefined;
  /** Optional wrapper class (defaults to a muted inline link style). */
  className?: string;
}

const DEFAULT_CLASS =
  "inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground";

/**
 * Renders an Instagram profile link whose visible text is ALWAYS "Instagram".
 * The stored `url` stays the link destination; only the label is normalized.
 * Opens in a new tab with safe rel, and renders nothing when no URL is given.
 */
export function InstagramLink({ url, className }: InstagramLinkProps) {
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={className ?? DEFAULT_CLASS}>
      <Instagram className="h-4 w-4" />
      Instagram
    </a>
  );
}
