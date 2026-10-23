export function OrganisationDomainsCard({ domains = [] as string[] }) {
  return (
    <section>
      <h2>Custom domains</h2>
      <ul>
        {domains.map((domain) => (
          <li key={domain}>{domain}</li>
        ))}
      </ul>
    </section>
  );
}
