import { PARTNERS } from "@/constants/partners";

export default function VendorFinderPage() {
  const partner = PARTNERS.find((item) => item.name === "Vendor Finder");
  return <iframe title="Vendor Finder" src={partner?.url} />;
}
