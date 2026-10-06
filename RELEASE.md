# Release Process

solumbe follows Semantic Versioning.

- Patch: bug fixes, docs corrections, low-risk test or CI improvements.
- Minor: new commands, new MCP tools, new report fields, or backward-compatible behavior.
- Major: removed commands, renamed fields, incompatible output changes, or changed runtime requirements.

Preserve this discipline across the stable 3.x line. There is no Solumbe 2.x: the `v2.x` tags belong to the earlier Repoctx releases, so 1.15.0 was followed by 3.0.0. Reserve the next major version for intentional CLI, MCP, cache, or runtime incompatibilities with an explicit migration guide.

## Checklist

1. Confirm the worktree is clean.
2. Run `npm ci`.
3. Run `npm run ci`.
4. Choose the release type from merged PR version-impact notes: patch, minor, or major.
5. Update `CHANGELOG.md`.
6. Bump `package.json` and `package-lock.json` together with `npm version <patch|minor|major> --no-git-tag-version`. The `version` lifecycle script resyncs `server.json` and the pinned doc versions and re-renders `docs/assets/solumbe-how-it-works.html` with the new version; commit them with the bump.
7. Run `npm run version:check`.
8. Commit the release changes.
9. Confirm npm Trusted Publishing is configured for `BASHBOP/solumbe` and `.github/workflows/release.yml`. The workflow uses GitHub OIDC (`id-token: write`) for provenance and does not require an `NPM_TOKEN` secret.
10. Confirm MCP Registry GitHub OIDC access is configured for `io.github.BASHBOP/solumbe`.
11. Merge the release into `main` with a merge commit, never a squash: a squash message can carry a skip-CI marker, and a commit CI skips is never tagged. That merge is the release decision.
12. Once `solumbe CI` passes on the merge commit, the `Tag release` workflow tags it `vX.Y.Z` from `package.json` and starts the `Release` workflow, which runs the full quality gate, publishes npm first, then creates the GitHub release and publishes `server.json` to the MCP Registry. It refuses a version that is not newer than the latest tag or that `CHANGELOG.md` has no section for. If CI did not run on that commit, tag it yourself: `git tag -a vX.Y.Z -m vX.Y.Z <sha> && git push origin vX.Y.Z`.
13. Verify the published binary:

```bash
npm install -g @bashbop/solumbe@4.3.0
solumbe doctor
```

## Compatibility Notes

The package exposes the `solumbe` binary. Release notes must call out any CLI output, JSON schema, MCP tool schema, generated workflow, cache format, Node.js engine, or package entrypoint changes.
