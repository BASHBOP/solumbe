import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateCodeMap, isVendorFile } from "../src/lib/code-map.js";

test("generateCodeMap classifies Next routes and symbols", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-web-"));
  fs.mkdirSync(path.join(root, "app", "events"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
  fs.writeFileSync(path.join(root, "app", "events", "page.tsx"), "export default function EventsPage() { return null; }\nexport const count = 1;\n");

  const result = generateCodeMap(root);
  assert.equal(result.ok, true);
  assert.equal(result.summary.routes, 1);
  assert.ok(result.files[0].symbols.some((symbol) => symbol.name === "count"));
});

test("generateCodeMap indexes Handlebars templates and predictable email supporting artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-email-artifacts-"));
  fs.mkdirSync(path.join(root, "src", "email", "templates"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "i18n"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "feature-flags", "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "email", "templates", "responsive-base.hbs"), "{{> shared-header}}\n{{organisationAudiencePreview}}\n");
  fs.writeFileSync(path.join(root, "src", "i18n", "en.json"), JSON.stringify({ "audience.preview.title": "Preview" }));
  fs.writeFileSync(path.join(root, "src", "feature-flags", "config", "production.json"), JSON.stringify({ audienceStudio: true }));

  const result = generateCodeMap(root);
  const template = result.files.find((file) => file.path === "src/email/templates/responsive-base.hbs");
  const translation = result.files.find((file) => file.path === "src/i18n/en.json");
  const config = result.files.find((file) => file.path === "src/feature-flags/config/production.json");

  assert.equal(template?.kind, "template");
  assert.ok(template?.imports.includes("shared-header"));
  assert.ok(template?.symbols.some((symbol) => symbol.name === "organisationAudiencePreview"));
  assert.equal(translation?.kind, "translation");
  assert.ok(translation?.symbols.some((symbol) => symbol.name === "audience.preview.title"));
  assert.equal(config?.kind, "config");
  assert.ok(config?.symbols.some((symbol) => symbol.name === "audienceStudio"));
});

test("generateCodeMap classifies Nest controllers and methods", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-api-"));
  fs.mkdirSync(path.join(root, "src", "events"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ main: "dist/main" }));
  fs.writeFileSync(
    path.join(root, "src", "events", "events.controller.ts"),
    "import { Controller, Get } from '@nestjs/common';\n@Controller('events')\nexport class EventsController {\n  @Get(':id')\n  findOne() {}\n}\n",
  );

  const result = generateCodeMap(root);
  assert.equal(result.summary.controllers, 1);
  assert.equal(result.files[0].controllerBasePath, "events");
  assert.deepEqual(result.files[0].httpMethods, [{ method: "GET", path: ":id" }]);
  assert.ok(result.files[0].symbols.some((symbol) => symbol.type === "class" && symbol.name === "EventsController"));
  assert.ok(result.files[0].symbols.some((symbol) => symbol.type === "method" && symbol.name === "findOne"));
});

test("generateCodeMap extracts Nest service class methods for context ranking", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-service-methods-"));
  fs.mkdirSync(path.join(root, "src", "email"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ main: "dist/main" }));
  fs.writeFileSync(
    path.join(root, "src", "email", "email.service.ts"),
    [
      "import { Injectable } from '@nestjs/common';",
      "@Injectable()",
      "export class EmailService {",
      "  async sendRsvpConfirmationEmail() {}",
      "  async sendBookingCancellation() {}",
      "  private async resolveEventEmailBranding() {}",
      "  private buildFromAddress = (name?: string) => name;",
      "  constructor() {}",
      "}",
      "",
    ].join("\n"),
  );

  const result = generateCodeMap(root);
  const file = result.files.find((item) => item.path === "src/email/email.service.ts");
  assert.ok(file);
  assert.ok(file.symbols.some((symbol) => symbol.type === "class" && symbol.name === "EmailService"));
  assert.ok(file.symbols.some((symbol) => symbol.type === "method" && symbol.name === "sendRsvpConfirmationEmail"));
  assert.ok(file.symbols.some((symbol) => symbol.type === "method" && symbol.name === "sendBookingCancellation"));
  assert.ok(file.symbols.some((symbol) => symbol.type === "method" && symbol.name === "resolveEventEmailBranding"));
  assert.ok(file.symbols.some((symbol) => symbol.type === "method" && symbol.name === "buildFromAddress"));
  assert.ok(!file.symbols.some((symbol) => symbol.name === "constructor"));
});

test("generateCodeMap ignores code-like strings in fixtures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-fixture-"));
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tests", "fixture.test.ts"),
    [
      "const fixture = \"import { Controller, Get } from '@nestjs/common';\\n@Controller('fake')\\nexport class FakeController { @Get(':id') find() {} }\";",
      "export const realFixture = true;",
      "",
    ].join("\n"),
  );

  const result = generateCodeMap(root);
  assert.equal(result.summary.controllers, 0);
  assert.equal(result.files[0].controllerBasePath, undefined);
  assert.deepEqual(result.files[0].httpMethods, []);
  assert.deepEqual(result.files[0].imports, []);
  assert.ok(result.files[0].symbols.some((symbol) => symbol.name === "realFixture"));
  assert.ok(!result.files[0].symbols.some((symbol) => symbol.name === "FakeController"));
});

test("generateCodeMap classifies Go source and test files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-go-"));
  fs.mkdirSync(path.join(root, "internal", "githubpr"), { recursive: true });
  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/pullpass\n\ngo 1.22\n");
  fs.writeFileSync(
    path.join(root, "internal", "githubpr", "evaluate.go"),
    [
      "package githubpr",
      "",
      'import "context"',
      "",
      "type Report struct{}",
      "",
      "func Evaluate(ctx context.Context) Report {",
      "  return Report{}",
      "}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "internal", "githubpr", "evaluate_test.go"),
    ["package githubpr", "", 'import "testing"', "", "func TestEvaluate(t *testing.T) {", "  _ = Evaluate", "}", ""].join("\n"),
  );

  const result = generateCodeMap(root);
  const sourceFile = result.files.find((file) => file.path === "internal/githubpr/evaluate.go");
  const testFile = result.files.find((file) => file.path === "internal/githubpr/evaluate_test.go");

  assert.equal(result.summary.tests, 1);
  assert.ok(sourceFile);
  assert.ok(testFile);
  assert.equal(sourceFile.kind, "source");
  assert.equal(testFile.kind, "test");
  assert.deepEqual(testFile.imports, ["testing"]);
  assert.ok(testFile.symbols.some((symbol) => symbol.name === "TestEvaluate"));
});

test("generateCodeMap records the repository packages a Go file imports", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-go-imports-"));
  const write = (/** @type {string} */ file, /** @type {string} */ text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("go.mod", '// module example.com/commented\nmodule "example.com/shop"\n\ngo 1.22\n');
  write("shop.go", 'package shop\n\nimport "example.com/shop/internal/stock"\n\nfunc Open() error { return stock.Reserve() }\n');
  write(
    "internal/stock/reserve.go",
    [
      "package stock",
      "",
      "import (",
      '  "errors"',
      '  "example.com/shop/internal/platform"',
      '  "example.com/shop/internal/onlytests"',
      '  "example.com/shopping/internal/platform"',
      '  "github.com/other/lib/internal/platform"',
      ")",
      "",
      "func Reserve() error { return platform.Retry(errors.New) }",
      "",
    ].join("\n"),
  );
  write("internal/platform/retry.go", "package platform\n\nfunc Retry(fn func(string) error) error { return nil }\n");
  write("internal/onlytests/helper_test.go", "package onlytests\n");
  // A nested module: its packages resolve against its own go.mod.
  write("tools/lint/go.mod", "module example.com/lint\n");
  write("tools/lint/main.go", 'package main\n\nimport (\n  "example.com/lint/rules"\n  "example.com/shop"\n)\n\nfunc main() {}\n');
  write("tools/lint/rules/rules.go", "package rules\n\nfunc All() []string { return nil }\n");

  const result = generateCodeMap(root);
  const importDirs = (/** @type {string} */ file) => result.files.find((entry) => entry.path === file)?.importDirs;

  assert.deepEqual(importDirs("shop.go"), ["internal/stock"]);
  // The standard library, a dependency, a module that only shares a prefix,
  // and a directory with no Go package name nothing here.
  assert.deepEqual(importDirs("internal/stock/reserve.go"), ["internal/platform"]);
  // The root package is the directory "".
  assert.deepEqual(importDirs("tools/lint/main.go"), ["tools/lint/rules", ""]);
  assert.equal(importDirs("internal/platform/retry.go"), undefined);

  fs.rmSync(root, { recursive: true, force: true });
});

test("generateCodeMap extracts C# namespace, class, interface, enum, methods, and using-directives", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-cs-"));
  fs.writeFileSync(
    path.join(root, "booking.aspx.cs"),
    [
      "using System;",
      "using System.Data;",
      "using System.Data.SqlClient;",
      "",
      "namespace WebProject",
      "{",
      "    public partial class booking : System.Web.UI.Page",
      "    {",
      "        protected void Page_Load(object sender, EventArgs e)",
      "        {",
      "            if (!IsPostBack) { LoadOwner(); }",
      "        }",
      "",
      "        protected void bookBtn_Click(object sender, EventArgs e) { }",
      "",
      "        private void LoadOwner() { }",
      "    }",
      "",
      "    internal interface IBookingService { void Book(int ownerId); }",
      "",
      "    public enum BookingStatus { InProgress, Completed, Cancelled }",
      "}",
      "",
    ].join("\n"),
  );

  const result = generateCodeMap(root);
  const file = result.files.find((f) => f.path === "booking.aspx.cs");
  assert.ok(file, "C# code-behind should be in the map");
  assert.ok(file.imports.includes("System.Data.SqlClient"), "should extract using directives");
  assert.ok(file.exports.includes("booking"), "public class is exported");
  assert.ok(file.exports.includes("BookingStatus"), "public enum is exported");
  assert.ok(!file.exports.includes("IBookingService"), "internal interface is not exported");
  assert.ok(file.symbols.some((s) => s.type === "namespace" && s.name === "WebProject"));
  assert.ok(file.symbols.some((s) => s.type === "class" && s.name === "booking"));
  assert.ok(file.symbols.some((s) => s.type === "interface" && s.name === "IBookingService"));
  assert.ok(file.symbols.some((s) => s.type === "enum" && s.name === "BookingStatus"));
  assert.ok(file.symbols.some((s) => s.type === "method" && s.name === "bookBtn_Click"));
  assert.ok(file.symbols.some((s) => s.type === "method" && s.name === "LoadOwner"));
});

test("generateCodeMap extracts Python classes, functions, imports, with comments/strings ignored", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-py-"));
  fs.writeFileSync(
    path.join(root, "service.py"),
    [
      '"""Module docstring with class Foo and def bar inside that should not match."""',
      "import os",
      "import sys as system",
      "import json, csv",
      "from fastapi import APIRouter, Depends",
      "from .auth import current_user",
      "from ..db import get_db",
      "",
      "# A comment with class FakeClass should be ignored",
      'COMMENT_LIKE = "class NotAClass:"',
      "",
      "class BookingService:",
      '    """def inside_string is not a function."""',
      "    def __init__(self, db):",
      "        self._db = db",
      "    async def create(self, body):",
      "        return await self._db.booking.create(data=body)",
      "    def _private_helper(self):",
      "        return None",
      "",
      "def helper_function(x):",
      "    return x * 2",
      "",
      "async def background_job():",
      "    pass",
      "",
      "class _Private:",
      "    pass",
      "",
    ].join("\n"),
  );

  const result = generateCodeMap(root);
  const file = result.files.find((f) => f.path === "service.py");
  assert.ok(file, "Python file should be in the map");

  assert.ok(file.imports.includes("os"));
  assert.ok(file.imports.includes("sys"), "alias should be stripped (sys as system → sys)");
  assert.ok(file.imports.includes("json") && file.imports.includes("csv"), "comma-separated imports both captured");
  assert.ok(file.imports.includes("fastapi"));
  assert.ok(file.imports.includes(".auth"), "relative imports preserved");
  assert.ok(file.imports.includes("..db"));

  assert.ok(file.symbols.some((s) => s.type === "class" && s.name === "BookingService"));
  assert.ok(file.symbols.some((s) => s.type === "class" && s.name === "_Private"));
  assert.ok(file.symbols.some((s) => s.type === "function" && s.name === "helper_function"));
  assert.ok(
    file.symbols.some((s) => s.type === "function" && s.name === "background_job"),
    "async def captured",
  );

  assert.ok(!file.symbols.some((s) => s.name === "Foo"), "class in docstring not matched");
  assert.ok(!file.symbols.some((s) => s.name === "FakeClass"), "class in comment not matched");
  assert.ok(!file.symbols.some((s) => s.name === "NotAClass"), "class in string literal not matched");
  assert.ok(!file.symbols.some((s) => s.type === "function" && s.name === "bar"), "def in docstring not matched");

  assert.ok(file.exports.includes("BookingService"));
  assert.ok(file.exports.includes("helper_function"));
  assert.ok(!file.exports.includes("_Private"), "underscore-prefixed names excluded from exports");
  assert.ok(!file.exports.includes("_private_helper"));
  assert.ok(!file.exports.includes("__init__"));
});

test("isVendorFile detects minified, library-named, and vendor-pathed files", () => {
  assert.equal(isVendorFile("js/jquery.min.js", ""), true, ".min.js suffix");
  assert.equal(isVendorFile("js/app.bundle.js", ""), true, ".bundle.js suffix");
  assert.equal(isVendorFile("vendor/anything.js", ""), true, "vendor/ path");
  assert.equal(isVendorFile("node_modules/foo/index.js", ""), true, "node_modules/ path");
  assert.equal(isVendorFile("bower_components/foo.js", ""), true, "bower_components/ path");
  assert.equal(isVendorFile("dist/bundle.js", ""), true, "dist/ path");
  assert.equal(isVendorFile("js/Bootstrap.js", ""), true, "library prefix (bootstrap, case-insensitive)");
  assert.equal(isVendorFile("js/jqueryv2.1.4.min.js", ""), true, "jquery prefix");
  assert.equal(isVendorFile("js/angular.min.js", ""), true, "angular prefix");

  assert.equal(isVendorFile("js/app.js", ""), false, "app.js is not vendor");
  assert.equal(isVendorFile("js/autocomplete.js", ""), false, "autocomplete.js is not vendor");
  assert.equal(isVendorFile("src/lib/foo.ts", ""), false, "normal source file");
  assert.equal(isVendorFile("src/components/Button.tsx", ""), false, "component file");

  const longLineBlob = "x".repeat(2000) + "\n" + "y\n".repeat(30000);
  assert.equal(isVendorFile("js/something.js", longLineBlob), true, "large file with very long lines (minified heuristic)");
});

test("generateCodeMap extracts Java package, classes, interfaces, enums, records, and imports", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-java-"));
  fs.writeFileSync(
    path.join(root, "BookingService.java"),
    [
      "package com.example.bookings;",
      "",
      "import java.util.List;",
      "import java.util.Optional;",
      "import static java.util.stream.Collectors.toList;",
      "",
      "public class BookingService {",
      "    public BookingService(Db db) {}",
      "    public Optional<Booking> findById(long id) { return Optional.empty(); }",
      "    private void log(String msg) {}",
      "}",
      "",
      "interface IBookingRepo {}",
      "",
      "public enum Status { ACTIVE, CANCELLED }",
      "public record CreateBooking(String carModel, int points) {}",
      "",
    ].join("\n"),
  );
  const result = generateCodeMap(root);
  const file = result.files[0];
  assert.ok(file);
  assert.ok(file.imports.includes("java.util.List"));
  assert.ok(file.imports.includes("java.util.stream.Collectors.toList"), "static imports captured");
  assert.ok(file.exports.includes("BookingService"));
  assert.ok(file.exports.includes("Status"));
  assert.ok(file.exports.includes("CreateBooking"));
  assert.ok(!file.exports.includes("IBookingRepo"), "package-private interface not exported");
  assert.ok(file.symbols.some((s) => s.type === "package" && s.name === "com.example.bookings"));
  assert.ok(file.symbols.some((s) => s.type === "class" && s.name === "BookingService"));
  assert.ok(file.symbols.some((s) => s.type === "interface" && s.name === "IBookingRepo"));
  assert.ok(file.symbols.some((s) => s.type === "enum" && s.name === "Status"));
  assert.ok(file.symbols.some((s) => s.type === "record" && s.name === "CreateBooking"));
  assert.ok(file.symbols.some((s) => s.type === "method" && s.name === "findById"));
});

test("generateCodeMap extracts Ruby modules, classes, methods, and require directives", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-rb-"));
  fs.writeFileSync(
    path.join(root, "service.rb"),
    [
      "require 'json'",
      "require_relative './lib/db'",
      "",
      "# A comment with class FakeClass should be ignored",
      "module Bookings",
      "  class Service",
      "    def initialize(db); @db = db; end",
      "    def create(body); @db.bookings.create(body); end",
      "    def self.factory(db); new(db); end",
      "    def safe?; true; end",
      "  end",
      "",
      "  module Errors",
      "    class NotFound < StandardError; end",
      "  end",
      "end",
      "",
    ].join("\n"),
  );
  const result = generateCodeMap(root);
  const file = result.files[0];
  assert.ok(file);
  assert.deepEqual(file.imports.sort(), ["./lib/db", "json"].sort(), "require and require_relative both captured");
  assert.ok(file.symbols.some((s) => s.type === "module" && s.name === "Bookings"));
  assert.ok(file.symbols.some((s) => s.type === "module" && s.name === "Errors"));
  assert.ok(file.symbols.some((s) => s.type === "class" && s.name === "Service"));
  assert.ok(file.symbols.some((s) => s.type === "class" && s.name === "NotFound"));
  assert.ok(
    file.symbols.some((s) => s.type === "method" && s.name === "factory"),
    "class method (def self.x) captured",
  );
  assert.ok(
    file.symbols.some((s) => s.type === "method" && s.name === "safe?"),
    "predicate methods captured",
  );
  assert.ok(!file.symbols.some((s) => s.name === "FakeClass"), "comment-only class not matched");
  assert.ok(file.exports.includes("Bookings"));
  assert.ok(file.exports.includes("Service"));
});

test("generateCodeMap extracts Rust use, mod, struct, enum, trait, fn with pub visibility", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-rs-"));
  fs.writeFileSync(
    path.join(root, "lib.rs"),
    [
      "use std::collections::HashMap;",
      "use crate::db::{Booking, Pool};",
      "",
      "pub mod auth;",
      "mod internal;",
      "",
      "pub struct BookingService { pool: Pool }",
      "",
      "pub trait Repo {",
      "    fn save(&self, b: Booking) -> Result<(), String>;",
      "}",
      "",
      "pub enum Status { Active, Cancelled }",
      "pub type Cents = u64;",
      "",
      "pub async fn create_booking(svc: &BookingService, b: Booking) -> Result<(), String> {",
      "    Ok(())",
      "}",
      "",
      "fn private_helper(x: u32) -> u32 { x + 1 }",
      "pub(crate) fn crate_visible() {}",
      "",
    ].join("\n"),
  );
  const result = generateCodeMap(root);
  const file = result.files[0];
  assert.ok(file);
  assert.ok(file.imports.some((i) => i.startsWith("std::collections::HashMap")));
  assert.ok(file.imports.some((i) => i.startsWith("crate::db::")));
  assert.ok(file.symbols.some((s) => s.type === "mod" && s.name === "auth"));
  assert.ok(file.symbols.some((s) => s.type === "mod" && s.name === "internal"));
  assert.ok(file.symbols.some((s) => s.type === "struct" && s.name === "BookingService"));
  assert.ok(file.symbols.some((s) => s.type === "trait" && s.name === "Repo"));
  assert.ok(file.symbols.some((s) => s.type === "enum" && s.name === "Status"));
  assert.ok(file.symbols.some((s) => s.type === "type" && s.name === "Cents"));
  assert.ok(file.symbols.some((s) => s.type === "function" && s.name === "create_booking"));
  assert.ok(file.symbols.some((s) => s.type === "function" && s.name === "private_helper"));

  assert.ok(file.exports.includes("auth"), "pub mod is exported");
  assert.ok(file.exports.includes("BookingService"));
  assert.ok(file.exports.includes("create_booking"), "pub async fn is exported");
  assert.ok(file.exports.includes("crate_visible"), "pub(crate) counts as pub");
  assert.ok(!file.exports.includes("internal"), "private mod is not exported");
  assert.ok(!file.exports.includes("private_helper"), "private fn is not exported");
});

test("generateCodeMap tags files with feature subdir as a secondary domain", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-domains-"));
  fs.mkdirSync(path.join(root, "components", "livestream"), { recursive: true });
  fs.mkdirSync(path.join(root, "app", "dashboard", "livestream"), { recursive: true });
  fs.mkdirSync(path.join(root, "components"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  fs.writeFileSync(path.join(root, "components", "livestream", "Player.tsx"), "export function Player() { return null; }\n");
  fs.writeFileSync(path.join(root, "components", "Button.tsx"), "export function Button() { return null; }\n");
  fs.writeFileSync(path.join(root, "app", "dashboard", "livestream", "page.tsx"), "export default function Page() { return null; }\n");

  const result = generateCodeMap(root);
  const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));

  const player = byPath["components/livestream/Player.tsx"];
  assert.equal(player.domain, "components", "primary domain preserved for backwards compat");
  assert.ok(player.domains.includes("livestream"), "feature subdir surfaces as a secondary domain tag");
  assert.ok(player.domains.includes("components"));

  const button = byPath["components/Button.tsx"];
  assert.deepEqual(button.domains, ["components"], "top-level component has no feature subdir");

  const page = byPath["app/dashboard/livestream/page.tsx"];
  assert.equal(page.domain, "dashboard");
  assert.ok(page.domains.includes("livestream"), "nested route surfaces feature segment too");

  const summary = Object.fromEntries(result.domains.map((d) => [d.name, d.fileCount]));
  assert.ok(summary.livestream >= 2, "summarizeDomains counts every tag a file carries");
  assert.ok(summary.components >= 2);
  assert.ok(summary.dashboard >= 1);
});

test("generateCodeMap summary counts every kind, symbol, and data-access hit in one pass", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-summary-"));
  fs.mkdirSync(path.join(root, "app", "events"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "events"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
  // Next route -> kind "route" maps to summary.routes (kind key differs from counter key).
  fs.writeFileSync(path.join(root, "app", "events", "page.tsx"), "export default function EventsPage() { return null; }\n");
  // Nest service with a Prisma call -> service kind + symbol + data-access hit, all on one file.
  fs.writeFileSync(
    path.join(root, "src", "events", "events.service.ts"),
    ["export class EventsService {", "  constructor(private readonly db) {}", "  findAll() {", "    return this.db.event.findMany();", "  }", "}", ""].join(
      "\n",
    ),
  );

  const result = generateCodeMap(root);
  const summary = result.summary;

  assert.equal(summary.routes, 1, "Next page counts as a route");
  assert.equal(summary.services, 1, "service.ts counts as a service");
  assert.equal(summary.controllers, 0);
  assert.equal(summary.apiClients, 0);
  assert.ok(summary.symbols >= 1, "symbols are summed across files");
  assert.equal(summary.dataAccessFiles, 1, "only the service file has data access");
  assert.ok(summary.dataAccessHits >= 1, "prisma findMany counted as a data-access hit");

  // Summary shape is stable: exactly the documented counters, no extras.
  assert.deepEqual(
    Object.keys(summary).sort(),
    [
      "apiClients",
      "apiRoutes",
      "components",
      "controllers",
      "dataAccessFiles",
      "dataAccessHits",
      "dtos",
      "hooks",
      "modules",
      "routes",
      "schemas",
      "services",
      "symbols",
      "tests",
    ].sort(),
  );
});

test("generateCodeMap flags vendor files via isVendor and downstream filters them in context_pack", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-vendor-"));
  fs.mkdirSync(path.join(root, "js"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "js", "jquery.min.js"), "// fake jquery\n");
  fs.writeFileSync(path.join(root, "js", "Bootstrap.js"), "// fake bootstrap\n");
  fs.writeFileSync(path.join(root, "js", "app.js"), "const x = 1;\n");
  fs.writeFileSync(path.join(root, "src", "main.ts"), "export function bookingHandler() { return 42; }\n");

  const result = generateCodeMap(root);
  const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
  assert.equal(byPath["js/jquery.min.js"].isVendor, true);
  assert.equal(byPath["js/Bootstrap.js"].isVendor, true);
  assert.equal(byPath["js/app.js"].isVendor, false);
  assert.equal(byPath["src/main.ts"].isVendor, false);
});

test("generateCodeMap indexes skill and documentation markdown with distinct kinds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-markdown-"));
  fs.mkdirSync(path.join(root, "codex", "skills", "model-router"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "routing"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "codex", "skills", "model-router", "SKILL.md"),
    [
      "---",
      "name: model-router",
      "description: >-",
      "  Route a task to a model tier.",
      "---",
      "",
      "# Model router",
      "",
      "## Sync",
      "",
      "See [the spec](../../../docs/routing/README.md).",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(root, "codex", "skills", "model-router", "examples.md"), "# Examples\n");
  fs.writeFileSync(path.join(root, "docs", "routing", "README.md"), "# Routing\n\n## Advisory footer\n");
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n");
  fs.writeFileSync(path.join(root, "src.ts"), "export const noop = 1;\n");

  const result = generateCodeMap(root);
  const byPath = Object.fromEntries(result.files.map((file) => [file.path, file]));
  const skill = byPath["codex/skills/model-router/SKILL.md"];

  assert.ok(skill, `SKILL.md missing from code map: ${Object.keys(byPath).join(", ")}`);
  assert.equal(skill.kind, "skill");
  assert.equal(byPath["codex/skills/model-router/examples.md"].kind, "skill", "companion pages ship with the skill");
  assert.equal(byPath["docs/routing/README.md"].kind, "doc");
  assert.equal(byPath["CHANGELOG.md"].kind, "changelog", "changelog keeps its own kind");

  // Frontmatter identifiers and headings are what a request naming the skill matches on.
  assert.ok(
    skill.symbols.some((symbol) => symbol.name === "model-router"),
    `expected the frontmatter name as a symbol, got: ${skill.symbols.map((s) => s.name).join(" | ")}`,
  );
  assert.ok(skill.symbols.some((symbol) => symbol.name === "Model router"));
  assert.ok(skill.symbols.some((symbol) => symbol.name === "Sync"));
  // The `>-` block-scalar marker is not a value, and the prose under it is not an identifier.
  assert.ok(!skill.symbols.some((symbol) => symbol.name.startsWith(">")));
  assert.ok(skill.imports.includes("../../../docs/routing/README.md"), `expected the relative link as an import, got: ${skill.imports.join(", ")}`);
  // Markdown never goes through the TypeScript parser, so prose yields no exports.
  assert.deepEqual(skill.exports, []);
});

test("generateCodeMap does not mine data-access hits from SQL quoted in documentation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-map-md-sql-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "queries.md"), ["# Queries", "", "```sql", '"SELECT id FROM bookings WHERE paid = 1"', "```", ""].join("\n"));

  const result = generateCodeMap(root);
  const doc = result.files.find((file) => file.path === "docs/queries.md");
  assert.equal(doc?.kind, "doc");
  assert.equal(doc?.dataAccess, undefined, "a SQL example in prose is not a query this repository runs");
});
