import {
  ClipboardCheck,
  DownloadCloud,
  LayoutDashboard,
  ListChecks,
  Send,
  Settings,
  Store,
  type LucideIcon,
} from "lucide-react";

export const APP_NAME = "Sauda Jasa";
export const APP_DESCRIPTION = "Internal admin system";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
}

/** Primary navigation shown in the sidebar. */
export const NAV_ITEMS: NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { title: "Import", href: "/import", icon: DownloadCloud },
  { title: "Import Queue", href: "/queue", icon: ListChecks },
  { title: "Boutiques", href: "/boutiques", icon: Store },
  { title: "Review Queue", href: "/review-queue", icon: ClipboardCheck },
  { title: "Telegram", href: "/telegram", icon: Send },
  { title: "Settings", href: "/settings", icon: Settings },
];
