import { PRODUCT_STAGES } from "../../../../../telemetry/product-events.ts";

const dimensions = [
  "component",
  "stage",
  "outcome",
  "reason",
  "model",
  "selected_rank",
  "policy_version",
  "deputydev_cli_version",
];
export const PRODUCT_HISTOGRAMS: Readonly<
  Record<string, { unit: string; boundaries: number[]; dimensions: string[] }>
> = Object.fromEntries([
  ...Object.keys(PRODUCT_STAGES).flatMap((category) => [
    [
      `deputydev.${category}.duration`,
      { unit: "s", boundaries: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300], dimensions },
    ],
    [
      `deputydev.${category}.transfer`,
      {
        unit: "By",
        boundaries: [1024, 16384, 262144, 1048576, 4194304, 16777216, 67108864, 134217728],
        dimensions,
      },
    ],
  ]),
  ...["confidence", "high_complexity_probability", "needs_deep_reasoning", "prioritizes_speed"].map(
    (score) => [
      `deputydev.recommender.${score}`,
      { unit: "1", boundaries: [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1], dimensions },
    ],
  ),
  [
    "deputydev.recommender.complexity",
    { unit: "1", boundaries: [0, 0.5, 1, 1.5, 2, 2.5, 3], dimensions },
  ],
  [
    "deputydev.recommender.candidate_count",
    { unit: "1", boundaries: [1, 2, 4, 8, 16, 32, 64, 128, 250], dimensions },
  ],
]);
