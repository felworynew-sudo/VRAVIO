import { describe, expect, it } from "vitest";
import { explainError } from "./explain";

describe("explainError", () => {
  it("turns a browser's raw network failure into a reason in the interface language", () => {
    const explained = explainError(new TypeError("Failed to fetch"), "ru");
    expect(explained.reason).toBe("Не удалось скачать нужные данные.");
    expect(explained.causes.length).toBeGreaterThan(0);
    expect(explained.remedies.length).toBeGreaterThan(0);
    expect(explained.technical).toBe("TypeError: Failed to fetch");
  });

  it("speaks English when the interface does", () => {
    expect(explainError("Failed to fetch", "en").reason).toBe("Could not download the required data.");
  });

  it("recognises an engine's error string, not only Error objects", () => {
    expect(explainError("RangeError: Array buffer allocation failed", "ru").reason).toBe("Не хватило памяти для этой операции.");
  });

  it("still explains something it has no row for, and keeps the raw text for the report", () => {
    const explained = explainError(new Error("zq-unknown"), "ru");
    expect(explained.reason).toBe("Произошла непредвиденная ошибка.");
    expect(explained.technical).toBe("zq-unknown");
  });
});
