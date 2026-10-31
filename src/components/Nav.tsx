"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const LINKS = [
  { href: "/", label: "Plan & compare" },
  { href: "/assistant", label: "Assistant" },
  { href: "/prices", label: "Price data" },
  { href: "/trips", label: "Saved trips" },
  { href: "/itinerary", label: "Itinerary" },
  { href: "/monitoring", label: "Monitoring" },
];

export function Nav() {
  const path = usePathname();
  const [unread, setUnread] = useState(0);
  // Refresh the unread count on navigation (no polling; monitoring is not real-time).
  useEffect(() => {
    let live = true;
    fetch("/api/notifications")
      .then((r) => (r.ok ? r.json() : { unread: 0 }))
      .then((b) => live && setUnread(b.unread ?? 0))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [path]);
  const active = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));
  return (
    <nav className="nav">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={active(l.href) ? "active" : undefined}>
          {l.label}
        </Link>
      ))}
      <Link href="/notifications" className={active("/notifications") ? "active" : undefined} aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} title="Notifications">
        🔔{unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
      </Link>
    </nav>
  );
}
