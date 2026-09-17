import { describe, expect, it } from "vitest";
import { verifyDenoiseSession } from "./run";
import type { DenoiseModelDefinition } from "./types";

const model: DenoiseModelDefinition = {
  id: "test-model",
  label: { en: "Test", ru: "Тест" },
  spec: { id: "test-model", url: "https://example.test/model.onnx", sizeBytes: 1024, inputShape: [1, 3, -1, -1], licence: "MIT", commercialUse: true },
};

describe("verifyDenoiseSession", () => {
  it("passes when the loaded model has exactly one input and one output", () => {
    expect(verifyDenoiseSession(model, { inputNames: ["input"], outputNames: ["output"] })).toBeNull();
  });

  it("reports a model with more than one input", () => {
    const message = verifyDenoiseSession(model, { inputNames: ["image", "mask"], outputNames: ["output"] });
    expect(message).toMatch(/exactly one input/);
    expect(message).toMatch(/2/);
  });

  it("reports a model with more than one output", () => {
    const message = verifyDenoiseSession(model, { inputNames: ["input"], outputNames: ["a", "b"] });
    expect(message).toMatch(/exactly one output/);
    expect(message).toMatch(/2/);
  });

  it("reports a model with no outputs at all", () => {
    const message = verifyDenoiseSession(model, { inputNames: ["input"], outputNames: [] });
    expect(message).toMatch(/exactly one output/);
  });
});
