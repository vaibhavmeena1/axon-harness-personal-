import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SPAN_INTERACTION } from "../src/attributes.ts";
import { PRODUCT_HISTOGRAMS } from "../src/otel/product-instruments.ts";

interface Target {
  expr?: string;
  query?: string;
  queryType?: string;
  limit?: number;
  legendFormat?: string;
}

interface Dashboard {
  panels: Array<{
    title: string;
    datasource: { type: string };
    targets: Target[];
  }>;
  templating: {
    list: Array<{
      name: string;
      label: string;
      query: string;
      definition: string;
      includeAll: boolean;
      allValue: string;
      multi: boolean;
    }>;
  };
}

const dashboard = JSON.parse(
  readFileSync(new URL("../grafana.json", import.meta.url), "utf8"),
) as Dashboard;
const emailMatcher = 'user_email=~"$user"';

test("Grafana user selector lists non-empty emails and supports multi-select and All", () => {
  const user = dashboard.templating.list.find((variable) => variable.name === "user");
  assert.ok(user);
  assert.equal(user.label, "User email");
  assert.equal(
    user.query,
    'label_values({__name__=~"pi_interaction_count_total|axon_.*_events_total",user_email!=""}, user_email)',
  );
  assert.equal(user.definition, user.query);
  assert.equal(user.includeAll, true);
  assert.equal(user.multi, true);
  assert.equal(user.allValue, ".+");
});

test("every Grafana metrics query respects the selected emails", () => {
  const panels = dashboard.panels.filter((panel) => panel.datasource.type === "prometheus");
  assert.ok(panels.length > 0);
  for (const panel of panels) {
    assert.ok(panel.targets.length > 0, panel.title);
    for (const target of panel.targets) {
      assert.ok(target.expr, panel.title);
      assert.ok(target.expr.includes(emailMatcher), panel.title);
      assert.doesNotMatch(target.expr, /user_id/, panel.title);
      assert.doesNotMatch(target.legendFormat ?? "", /user_id/, panel.title);
    }
  }
});

test("Grafana repository options and user-facing series follow email selection", () => {
  const repo = dashboard.templating.list.find((variable) => variable.name === "repo");
  assert.ok(repo);
  assert.ok(repo.query.includes(emailMatcher));
  assert.equal(repo.definition, repo.query);
  const operational = dashboard.panels.find((panel) => panel.title === "Operational rate");
  assert.ok(operational);
  for (const target of operational.targets) {
    assert.ok(target.expr?.includes("by (user_email)"));
    assert.ok(target.legendFormat?.includes("{{user_email}}"));
  }
});

test("every Grafana trace query uses email selection and bounded TraceQL search", () => {
  const traces = dashboard.panels.filter((panel) => panel.datasource.type === "tempo");
  assert.equal(traces.length, 2);
  for (const panel of traces) {
    assert.ok(panel.targets.length > 0, panel.title);
    for (const target of panel.targets) {
      assert.ok(target.query, panel.title);
      assert.equal(target.queryType, "traceql", panel.title);
      assert.equal(target.limit, 50, panel.title);
      assert.ok(target.query.includes('resource."user.email" =~ "$user"'), panel.title);
      assert.doesNotMatch(target.query, /user\.id/, panel.title);
    }
  }
});

test("interaction traces retain the current span name and repository selection", () => {
  const panel = dashboard.panels.find((panel) => panel.title === "Recent interaction traces");
  assert.ok(panel);
  assert.equal(panel.datasource.type, "tempo");
  assert.equal(panel.targets.length, 1);
  assert.equal(
    panel.targets[0]?.query,
    `{ name = "${SPAN_INTERACTION}" && resource."user.email" =~ "$user" && span."pi.repo.slug" =~ "$repo" }`,
  );
});

test("recommender traces match CLI resource identity or backend span identity without a repo constraint", () => {
  const panel = dashboard.panels.find((panel) => panel.title === "Recent recommender traces");
  assert.ok(panel);
  assert.equal(panel.datasource.type, "tempo");
  assert.equal(panel.targets.length, 1);
  assert.equal(
    panel.targets[0]?.query,
    '{ name = "axon.recommender.request" && (resource."user.email" =~ "$user" || span."user.email" =~ "$user") }',
  );
});

test("product histograms use the declared instrument names and translated units", () => {
  const expectedNames = new Set(
    Object.entries(PRODUCT_HISTOGRAMS).map(([name, { unit }]) => {
      const suffix = unit === "s" ? "_seconds" : unit === "By" ? "_bytes" : "";
      return `${name.replaceAll(".", "_")}${suffix}_bucket`;
    }),
  );
  const queries = dashboard.panels.flatMap((panel) =>
    panel.targets.map((target) => target.expr ?? ""),
  );
  const names = queries.flatMap((query) => query.match(/axon_\w+_bucket/g) ?? []);
  assert.ok(names.length > 0);
  for (const name of names) assert.ok(expectedNames.has(name), name);
});

test("product metrics separate CLI funnel counts from backend requests and avoid repo/ID labels", () => {
  const productPanels = dashboard.panels.filter((panel) =>
    panel.targets.some((target) => target.expr?.includes("axon_")),
  );
  assert.ok(productPanels.length > 0);
  for (const panel of productPanels) {
    for (const target of panel.targets) {
      assert.ok(target.expr, panel.title);
      assert.doesNotMatch(target.expr, /pi_repo_slug|recommendation_id|session_id/, panel.title);
      if (panel.title === "Model recommender request p95") {
        assert.ok(target.expr.includes("by (le, component)"));
      } else {
        assert.ok(target.expr.includes('component="cli"'), panel.title);
      }
    }
  }
});
