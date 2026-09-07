import Link from "next/link";
import { Store } from "lucide-react";

import { ThemeToggle } from "@/components/layout/theme-toggle";
import { SearchBar } from "@/features/marketplace/components/search-bar";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Store className="h-4 w-4" />
          </span>
          <span className="hidden sm:inline">Sauda Jasa</span>
        </Link>

        <nav className="hidden items-center gap-4 text-sm text-muted-foreground md:flex">
          <Link href="/" className="transition-colors hover:text-foreground">
            Home
          </Link>
          <Link href="/categories" className="transition-colors hover:text-foreground">
            Categories
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <div className="hidden w-56 lg:block">
            <SearchBar />
          </div>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
