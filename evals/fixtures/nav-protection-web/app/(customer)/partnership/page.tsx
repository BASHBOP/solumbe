import { PARTNERS } from "@/constants/partners";

export default function PartnershipPage() {
  return (
    <main>
      <h1>Partner with us</h1>
      {PARTNERS.map((partner) => (
        <a key={partner.name} href={partner.url}>
          {partner.name}
        </a>
      ))}
    </main>
  );
}
