import { describe, expect, it } from "vitest";
import { verifySegmentSession } from "./run";
import type { SegmentModelDefinition } from "./types";

const model: SegmentModelDefinition = {
  id: "test-model",
  label: { en: "Test", ru: "Тест" },
  spec: { id: "test-model", url: "https://example.test/model.onnx", sizeBytes: 1024, inputShape: [1, 3, 320, 320], licence: "MIT", commercialUse: true },
  input: { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
  size: 320,
  outputIndex: 0,
};

describe("verifySegmentSession", () => {
  it("passes when the loaded model has exactly one input and enough outputs", () => {
    expect(verifySegmentSession(model, { inputNames: ["input.1"], outputNames: ["1959", "1960"] })).toBeNull();
  });

  it("reports a model with more than one input", () => {
    const message = verifySegmentSession(model, { inputNames: ["image", "mask"], outputNames: ["out"] });
    expect(message).toMatch(/exactly one input/);
    expect(message).toMatch(/2/);
  });

  it("reports a model with no outputs at all", () => {
    const message = verifySegmentSession(model, { inputNames: ["input.1"], outputNames: [] });
    expect(message).toMatch(/output index 0/);
  });

  it("reports an output index past what the model actually has", () => {
    const wideModel: SegmentModelDefinition = { ...model, outputIndex: 3 };
    const message = verifySegmentSession(wideModel, { inputNames: ["input.1"], outputNames: ["a", "b"] });
    expect(message).toMatch(/output index 3/);
  });
});
