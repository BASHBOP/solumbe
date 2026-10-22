import { PackageSelector } from "../packages/PackageSelector";

export function EmailQuotaUpgradeModal({ onUpgrade }: { onUpgrade: (packageId: string) => void }) {
  return <PackageSelector packages={[{ id: "pro", name: "Pro package" }]} onUpgrade={onUpgrade} />;
}
