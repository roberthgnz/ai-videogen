import { t as translate, localizedLabels } from "@/lib/i18n";
import Link from "next/link";

const TABS = localizedLabels((translate) => ([
  {
    id: "projects",
    href: "/",
    label: translate("Projects"),
    icon: <><rect width="7" height="7" x="3" y="3" rx="1.5" /><rect width="7" height="7" x="14" y="3" rx="1.5" /><rect width="7" height="7" x="3" y="14" rx="1.5" /><rect width="7" height="7" x="14" y="14" rx="1.5" /></>,
  },
  {
    id: "library",
    href: "/library",
    label: translate("Library"),
    icon: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18M9 21V9" /></>,
  },
  {
    id: "style",
    href: "/style",
    label: translate("My style"),
    icon: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" />,
  },
  {
    id: "settings",
    href: "/settings",
    label: translate("Settings"),
    icon: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
  },
] as const));

export type AppSection = (typeof TABS)[number]["id"];

/**
 * The app's navigation, the same on every page outside the studio: where you are and where you can go,
 * always in the same place. An iOS tab bar: a floating capsule at the top of a wide window (as on iPadOS),
 * a bar along the bottom of a narrow one (as on iPhone). The page it is on is the raised, tinted tab.
 *
 * The tabs are a sibling of the bar, not a child: the bar is a material (backdrop-filter), and a fixed
 * element inside one is placed against it instead of the window.
 */
export function AppNav({ current, children }: { current: AppSection; /** Actions of this page, at the trailing edge of the bar. */ children?: React.ReactNode }) {
  return (
    <>
      <header className="app-bar">
        <Link href="/" className="app-brand" aria-label={translate("VideoGen: Go to projects")}>
          <svg width="18" height="22" viewBox="0 0 18 22" fill="none" aria-hidden><path d="M3 7v9M7 3v16M11 5v12M15 8v7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg>
          <span>VideoGen</span>
        </Link>
        {children && <div className="app-bar-end">{children}</div>}
      </header>
      <nav className="app-tabs" aria-label={translate("Sections")}>
        {TABS.map((tab) => (
          <Link key={tab.id} href={tab.href} aria-current={tab.id === current ? "page" : undefined}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{tab.icon}</svg>
            <span>{tab.label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
