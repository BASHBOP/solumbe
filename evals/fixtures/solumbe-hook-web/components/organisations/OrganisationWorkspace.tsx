export function OrganisationWorkspace({ staged = false }: { staged?: boolean }) {
  return <section>{staged ? "Changes staged for review" : "Workspace up to date"}</section>;
}
