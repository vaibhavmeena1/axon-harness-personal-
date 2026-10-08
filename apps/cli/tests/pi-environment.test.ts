import { describe, expect, test } from "bun:test";
import { createPiEnvironment } from "../src/harnesses/pi/environment.ts";
import { PRODUCT_IDENTITY } from "../src/product/identity.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

const paths = resolveAxonPaths({ AXON_HOME: "/managed/axon" });

describe("Pi provider display name", () => {
  test.each([{}, { LITELLM_DISPLAY_NAME: undefined }])(
    "supplies a product-derived default when the display name is unset: %j",
    (inheritedEnvironment) => {
      const original = { ...inheritedEnvironment };
      const environment = createPiEnvironment(inheritedEnvironment, paths);

      expect(environment["LITELLM_DISPLAY_NAME"]).toBe(
        `${PRODUCT_IDENTITY.displayName} AI Gateway`,
      );
      expect(inheritedEnvironment).toEqual(original);
    },
  );

  test.each(["Company AI Gateway", "  Team Gateway  ", "", "   ", "undefined"])(
    "preserves the explicit display name %j for the provider to interpret",
    (displayName) => {
      const inheritedEnvironment = {
        LITELLM_DISPLAY_NAME: displayName,
        OPENAI_API_KEY: "personal-key",
      };
      const environment = createPiEnvironment(inheritedEnvironment, paths, {
        LITELLM_API_KEY: "relay-capability",
        LITELLM_BASE_URL: "http://127.0.0.1:12345/litellm",
      });

      expect(environment["LITELLM_DISPLAY_NAME"]).toBe(displayName);
      expect(environment["LITELLM_API_KEY"]).toBe("relay-capability");
      expect(environment["LITELLM_BASE_URL"]).toBe("http://127.0.0.1:12345/litellm");
      expect(environment["OPENAI_API_KEY"]).toBeUndefined();
      expect(inheritedEnvironment).toEqual({
        LITELLM_DISPLAY_NAME: displayName,
        OPENAI_API_KEY: "personal-key",
      });
    },
  );

  test("keeps subsequent override layers authoritative", () => {
    const environment = createPiEnvironment({}, paths, {
      LITELLM_DISPLAY_NAME: "Launch-specific Gateway",
    });
    expect(environment["LITELLM_DISPLAY_NAME"]).toBe("Launch-specific Gateway");

    const removed = createPiEnvironment({}, paths, { LITELLM_DISPLAY_NAME: undefined });
    expect(removed["LITELLM_DISPLAY_NAME"]).toBeUndefined();
  });
});
