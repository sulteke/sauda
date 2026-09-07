import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";

/** Native GET form → /search?q=… (SSR + SEO friendly, no client JS). */
export function SearchBar({ defaultValue = "" }: { defaultValue?: string }) {
  return (
    <form action="/search" method="get" className="relative" role="search">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        name="q"
        type="search"
        defaultValue={defaultValue}
        placeholder="Search boutiques or @handle"
        className="pl-9"
        aria-label="Search boutiques"
      />
    </form>
  );
}
