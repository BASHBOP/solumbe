import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatDoctorReport, getDoctorReport } from "../src/lib/doctor.js";

const sampleReport = {
  ok: true,
  tools: [
    { name: "node", command: "node", available: true, version: "v22.12.0", installHint: "Install Node.js 18+." },
    { name: "rg", command: "rg", available: false, version: undefined, installHint: "Install ripgrep for faster source searching." },
  ],
};

test("getDoctorReport returns a normalized shape", () => {
  const report = getDoctorReport();
  assert.equal(report.ok, true);
  assert.ok(Array.isArray(report.tools));
  for (const tool of report.tools) {
    assert.ok(typeof tool.name === "string");
    assert.ok(typeof tool.command === "string");
    assert.ok(typeof tool.available === "boolean");
    assert.ok(typeof tool.installHint === "string");
  }
});

test("getDoctorReport checks the gh CLI used by pr_merge_readiness", () => {
  const report = getDoctorReport();
  const gh = report.tools.find((tool) => tool.name === "gh");
  assert.ok(gh, "doctor must include a gh check");
  assert.equal(gh.command, "gh");
  assert.match(gh.installHint, /pr_merge_readiness/);
});

test("formatDoctorReport renders a missing gh as a warn line", () => {
  const report = {
    ok: true,
    tools: [{ name: "gh", command: "gh", available: false, version: undefined, installHint: "Install the GitHub CLI; required by pr_merge_readiness." }],
  };
  const output = formatDoctorReport(report, { emoji: false });
  assert.match(output, /\[WARN\]/);
  assert.match(output, /gh/);
  assert.match(output, /pr_merge_readiness/);
});

test("formatDoctorReport renders fancy header and status lines", () => {
  const output = formatDoctorReport(sampleReport, { emoji: true });
  assert.match(output, /solumbe doctor/);
  assert.match(output, /✅/);
  assert.match(output, /node/);
  assert.match(output, /v22\.12\.0/);
  assert.match(output, /⚠️/);
  assert.match(output, /Install ripgrep/);
});

test("formatDoctorReport drops emojis in plain mode", () => {
  const output = formatDoctorReport(sampleReport, { emoji: false });
  assert.match(output, /\[OK\]/);
  assert.match(output, /\[WARN\]/);
  assert.ok(!output.includes("✅"));
  assert.ok(!output.includes("📋"));
});

test("doctor says when the user config is read from the pre-rename file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-doctor-test-"));
  const env = { XDG_CONFIG_HOME: tmp };
  try {
    const clean = getDoctorReport(env);
    assert.equal(clean.userConfig?.source, "none");
    assert.doesNotMatch(formatDoctorReport(clean, { emoji: false }), /user config/);

    const legacy = path.join(tmp, "otito", "config.json"); // rebrand-keep
    fs.mkdirSync(path.dirname(legacy));
    fs.writeFileSync(legacy, JSON.stringify({ telemetry: true }));
    const report = getDoctorReport(env);
    assert.equal(report.userConfig?.source, "legacy");
    const output = formatDoctorReport(report, { emoji: false });
    assert.match(output, /\[WARN\]\s+user config/);
    assert.ok(output.includes(legacy), "names the file it read");
    assert.ok(output.includes(`mv "${legacy}" "${path.join(tmp, "solumbe", "config.json")}"`), "says how to move it");
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});
