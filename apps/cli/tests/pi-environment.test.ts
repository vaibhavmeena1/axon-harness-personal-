import { describe, expect, test } from "bun:test";
import { createPiEnvironment } from "../src/harnesses/pi/environment.ts";
import { PRODUCT_IDENTITY } from "../src/product/identity.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

const paths = resolveAxonPaths({ AXON_HOME: "/managed/axon" });

describe("Pi remote clipboard", () => {
  test("forwards an explicit OSC 52 opt-in without enabling it by default", () => {
    const inheritedEnvironment = { PI_CLIPBOARD_OSC52: "1" };
    expect(createPiEnvironment(inheritedEnvironment, paths)["PI_CLIPBOARD_OSC52"]).toBe("1");
    expect(inheritedEnvironment).toEqual({ PI_CLIPBOARD_OSC52: "1" });
    expect(createPiEnvironment({}, paths)["PI_CLIPBOARD_OSC52"]).toBeUndefined();
  });
});

describe("Pi LiteLLM provider configuration", () => {
  test("preserves explicit alias configuration without replacing managed relay overrides", () => {
    const inheritedEnvironment = {
      LITELLM_PROVIDERS: "team-a",
      LITELLM_PROVIDERS_JSON: JSON.stringify({ "team-b": { baseUrl: "https://b.example" } }),
      LITELLM_PROVIDER_TEAM_A_BASE_URL: "https://a.example",
      LITELLM_PROVIDER_TEAM_A_API_KEY: "team-a-key",
      LITELLM_BASE_URL: "https://ambient.example",
      LITELLM_API_KEY: "ambient-key",
    };
    const original = { ...inheritedEnvironment };
    const environment = createPiEnvironment(inheritedEnvironment, paths, {
      LITELLM_BASE_URL: "http://127.0.0.1:12345/litellm",
      LITELLM_API_KEY: "relay-capability",
    });

    for (const name of [
      "LITELLM_PROVIDERS",
      "LITELLM_PROVIDERS_JSON",
      "LITELLM_PROVIDER_TEAM_A_BASE_URL",
      "LITELLM_PROVIDER_TEAM_A_API_KEY",
    ]) {
      expect(environment[name]).toBe(Reflect.get(inheritedEnvironment, name));
    }
    expect(environment["LITELLM_BASE_URL"]).toBe("http://127.0.0.1:12345/litellm");
    expect(environment["LITELLM_API_KEY"]).toBe("relay-capability");
    expect(inheritedEnvironment).toEqual(original);
  });
});

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
