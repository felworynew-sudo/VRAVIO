import { describe, expect, it } from "vitest";
import { buildIccProfile, parseIccProfile } from "./icc";
import { rasterColorSpaces } from "./color-space";

/**
 * docs/master-plan.md §59.3: profiles written into exported files, and read back out of imported
 * ones. The round trip is the test that matters — a profile this editor writes and cannot read is
 * a profile no other application will read either.
 */

describe("ICC profiles", () => {
  it("writes a profile every one of our spaces can be recognised from again", () => {
    for (const space of rasterColorSpaces) {
      const profile = buildIccProfile(space.id);
      const parsed = parseIccProfile(profile);

      expect(parsed, space.id).not.toBeNull();
      expect(parsed!.space, `${space.id} round trip (${parsed!.unsupported ?? "matched"})`).toBe(space.id);
      expect(parsed!.description).toBe(space.label.en);
    }
  });

  it("writes a structurally valid ICC header", () => {
    const profile = buildIccProfile("srgb");
    const view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);

    expect(view.getUint32(0)).toBe(profile.length);                                 // size field matches the file
    expect(String.fromCharCode(...profile.subarray(36, 40))).toBe("acsp");          // the profile signature
    expect(String.fromCharCode(...profile.subarray(16, 20))).toBe("RGB ");
    expect(String.fromCharCode(...profile.subarray(20, 24))).toBe("XYZ ");
    expect(profile.length % 4).toBe(0);                                             // tag data is 4-byte aligned
  });

  it("tells sRGB from Linear sRGB, which share their primaries exactly", () => {
    // Only the tone curve separates them, so this is what proves the TRC is written and compared.
    expect(parseIccProfile(buildIccProfile("linear-srgb"))!.space).toBe("linear-srgb");
    expect(parseIccProfile(buildIccProfile("srgb"))!.space).toBe("srgb");
  });

  it("says what it cannot read instead of guessing", () => {
    const cmyk = buildIccProfile("srgb");
    // Same profile, relabelled as CMYK data — the one field that decides whether this parser has
    // anything to say about it.
    cmyk.set([0x43, 0x4d, 0x59, 0x4b], 16);
    const parsed = parseIccProfile(cmyk)!;

    expect(parsed.space).toBeNull();
    expect(parsed.unsupported).toContain("CMYK");
  });

  it("returns null for bytes that are not a profile at all", () => {
    expect(parseIccProfile(new Uint8Array(200))).toBeNull();
    expect(parseIccProfile(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
