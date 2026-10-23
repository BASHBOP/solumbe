const LINKS = [
  { label: "Events", href: "/events" },
  { label: "Vendor Finder", href: "/service-providers/vendor-finder" },
  { label: "Partners", href: "/partnership" },
];

export function NavbarRedesigned() {
  return (
    <header>
      {LINKS.map((link) => (
        <a key={link.href} href={link.href}>
          {link.label}
        </a>
      ))}
    </header>
  );
}
