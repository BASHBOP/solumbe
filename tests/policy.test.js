import test from "node:test";
import assert from "node:assert/strict";
import { aggregateVerdict, normalizeGovernance, normalizeProfile, policyCheck, PROFILES, STATUS } from "../src/lib/policy.js";

test("normalizeProfile accepts aliases", () => {
  assert.equal(normalizeProfile(""), PROFILES.standard);
  assert.equal(normalizeProfile("standard"), PROFILES.standard);
  assert.equal(normalizeProfile("Company"), PROFILES.company);
  assert.equal(normalizeProfile("team"), PROFILES.company);
  assert.equal(normalizeProfile("high-risk"), PROFILES.highRisk);
  assert.equal(normalizeProfile("strict"), PROFILES.highRisk);
  assert.throws(() => normalizeProfile("foo"), /unknown policy profile/);
});

test("normalizeGovernance accepts team and solo only", () => {
  assert.equal(normalizeGovernance(""), "team");
  assert.equal(normalizeGovernance("Solo"), "solo");
  assert.throws(() => normalizeGovernance("rogue"), /unknown governance/);
});

test("aggregateVerdict prefers FAIL over WARN over PASS", () => {
  assert.equal(aggregateVerdict([{ status: STATUS.pass }, { status: STATUS.pass }]), STATUS.pass);
  assert.equal(aggregateVerdict([{ status: STATUS.pass }, { status: STATUS.warn }]), STATUS.warn);
  assert.equal(aggregateVerdict([{ status: STATUS.warn }, { status: STATUS.fail }]), STATUS.fail);
});

test("aggregateVerdict ignores SKIPPED checks", () => {
  assert.equal(aggregateVerdict([{ status: STATUS.pass }, { status: STATUS.skipped }]), STATUS.pass);
  assert.equal(aggregateVerdict([{ status: STATUS.skipped }, { status: STATUS.skipped }]), STATUS.pass);
  assert.equal(aggregateVerdict([{ status: STATUS.skipped }, { status: STATUS.warn }]), STATUS.warn);
  assert.equal(aggregateVerdict([{ status: STATUS.skipped }, { status: STATUS.fail }]), STATUS.fail);
});

test("company policy does not accept a SKIPPED required control as evidence", () => {
  const checks = ["Review decision", "CODEOWNERS", "Review conversations", "Branch protection", "Status checks"].map((name) => ({
    name,
    status: name === "CODEOWNERS" ? STATUS.skipped : STATUS.pass,
    summary: "",
  }));
  const result = policyCheck({ profile: PROFILES.company, governance: "team", files: [], checks, remote: true });
  assert.equal(result.status, STATUS.fail);
  assert.ok(result.details.some((detail) => detail.startsWith("CODEOWNERS must be PASS, got SKIPPED")));
});

test("standard policyCheck always passes", () => {
  const result = policyCheck({ profile: PROFILES.standard, governance: "team", files: [], checks: [], remote: false });
  assert.equal(result.status, STATUS.pass);
});

test("company policyCheck fails in local mode (no remote evidence)", () => {
  const result = policyCheck({ profile: PROFILES.company, governance: "team", files: [], checks: [], remote: false });
  assert.equal(result.status, STATUS.fail);
  assert.ok(result.details.some((line) => line.includes("GitHub PR mode evidence")));
});

test("company policyCheck fails for solo governance even with remote", () => {
  const result = policyCheck({
    profile: PROFILES.company,
    governance: "solo",
    files: [],
    checks: [
      { name: "Review decision", status: STATUS.pass, summary: "ok" },
      { name: "CODEOWNERS", status: STATUS.pass, summary: "ok" },
      { name: "Review conversations", status: STATUS.pass, summary: "ok" },
      { name: "Branch protection", status: STATUS.pass, summary: "ok" },
      { name: "Status checks", status: STATUS.pass, summary: "ok" },
    ],
    remote: true,
  });
  assert.equal(result.status, STATUS.fail);
  assert.ok(result.details.some((line) => line.includes("solo-maintainer")));
});

test("high-risk policyCheck warns locally with risky files but no policy issues", () => {
  const result = policyCheck({
    profile: PROFILES.highRisk,
    governance: "team",
    files: ["src/utils/format.ts"],
    checks: [],
    remote: false,
  });
  assert.equal(result.status, STATUS.fail, "local mode without remote evidence should still fail high-risk");
});

test("high-risk policyCheck passes when remote evidence is satisfied", () => {
  const result = policyCheck({
    profile: PROFILES.highRisk,
    governance: "team",
    files: ["src/utils/format.ts"],
    checks: [
      { name: "Review decision", status: STATUS.pass, summary: "ok" },
      { name: "CODEOWNERS", status: STATUS.pass, summary: "ok" },
      { name: "Review conversations", status: STATUS.pass, summary: "ok" },
      { name: "Branch protection", status: STATUS.pass, summary: "ok" },
      { name: "Status checks", status: STATUS.pass, summary: "ok" },
    ],
    remote: true,
  });
  assert.equal(result.status, STATUS.pass);
});
