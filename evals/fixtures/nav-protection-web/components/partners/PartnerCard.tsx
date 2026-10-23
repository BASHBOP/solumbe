type Partner = { name: string; url: string; description: string };

export function PartnerCard({ partner }: { partner: Partner }) {
  return (
    <article>
      <h3>{partner.name}</h3>
      <p>{partner.description}</p>
      <a href={partner.url}>Visit partner</a>
    </article>
  );
}
