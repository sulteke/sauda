import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-12 border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>Sauda Jasa — discover boutiques across Almaty.</p>
        <nav className="flex gap-4">
          <Link href="/" className="hover:text-foreground">
            Home
          </Link>
          <Link href="/categories" className="hover:text-foreground">
            Categories
          </Link>
          <Link href="/search" className="hover:text-foreground">
            Search
          </Link>
        </nav>
      </div>
    </footer>
  );
}
