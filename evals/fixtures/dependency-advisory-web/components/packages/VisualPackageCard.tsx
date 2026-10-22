export function VisualPackageCard({ name, onSelect }: { name: string; onSelect: () => void }) {
  return <button onClick={onSelect}>Upgrade to {name}</button>;
}
