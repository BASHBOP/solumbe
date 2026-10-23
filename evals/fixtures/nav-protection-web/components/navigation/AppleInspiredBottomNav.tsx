const NAV_ITEMS = [
  { label: "Home", href: "/" },
  { label: "Partners", href: "/partnership" },
  { label: "Vendors", href: "/service-providers" },
];

export function AppleInspiredBottomNav() {
  return (
    <nav>
      {NAV_ITEMS.map((item) => (
        <a key={item.href} href={item.href}>
          {item.label}
        </a>
      ))}
    </nav>
  );
}
