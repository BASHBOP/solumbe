export function NdaGate({ accepted, children }: { accepted: boolean; children: React.ReactNode }) {
  if (!accepted) return <p>Accept the NDA to continue.</p>;
  return <>{children}</>;
}
