import { VisualPackageCard } from "./VisualPackageCard";

export function PackageSelector({ packages, onUpgrade }: { packages: { id: string; name: string }[]; onUpgrade: (id: string) => void }) {
  return (
    <div>
      {packages.map((pkg) => (
        <VisualPackageCard key={pkg.id} name={pkg.name} onSelect={() => onUpgrade(pkg.id)} />
      ))}
    </div>
  );
}
