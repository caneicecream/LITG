"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Plan & compare" },
  { href: "/prices", label: "Price data" },
  { href: "/trips", label: "Saved trips" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={path === l.href ? "active" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
