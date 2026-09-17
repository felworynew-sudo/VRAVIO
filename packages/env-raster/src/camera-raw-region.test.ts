import { describe, expect, it } from "vitest";
import { applyCameraRawFilter, cameraRawRegionMargin, defaultCameraRawFilterSettings, type CameraRawFilterSettings } from "./index";

/** docs/master-plan.md §58.1: Camera Raw renders a zoomed-in view as a region of interest, the way
 *  darktable's pixelpipe does. A region with its margin must look like the same place in the whole
 *  image — including the image-centred vignette and the position-keyed grain. */
function photo(width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 4;
    pixels[index] = (x * 3 + (x * y) % 17) & 255; pixels[index + 1] = (y * 2 + (x ^ y) % 23) & 255; pixels[index + 2] = ((x + y) * 5) & 255; pixels[index + 3] = 255;
  }
  return pixels;
}

const everything: CameraRawFilterSettings = {
  ...defaultCameraRawFilterSettings,
  exposure: 0.4, contrast: 20, texture: 30, clarity: 40, noiseLuminance: 50, noiseColor: 40,
  sharpenAmount: 60, sharpenRadius: 1.5, vignetteAmount: -40, grainAmount: 30, grainSize: 40,
};

describe("Camera Raw region-of-interest rendering", () => {
  it("a region rendered with its margin matches the whole image there", () => {
    const width = 160, height = 120, source = photo(width, height);
    const whole = applyCameraRawFilter(source, width, height, everything);
    const region = { x: 70, y: 40, width: 50, height: 45 }, margin = cameraRawRegionMargin(everything, 1);
    const left = Math.max(0, region.x - margin), top = Math.max(0, region.y - margin);
    const right = Math.min(width, region.x + region.width + margin), bottom = Math.min(height, region.y + region.height + margin);
    const cropWidth = right - left, cropHeight = bottom - top, crop = new Uint8ClampedArray(cropWidth * cropHeight * 4);
    for (let y = 0; y < cropHeight; y += 1) crop.set(source.subarray(((top + y) * width + left) * 4, ((top + y) * width + right) * 4), y * cropWidth * 4);
    const rendered = applyCameraRawFilter(crop, cropWidth, cropHeight, everything, { imageWidth: width, imageHeight: height, offsetX: left, offsetY: top, scale: 1 });
    let worst = 0;
    for (let y = region.y; y < region.y + region.height; y += 1) for (let x = region.x; x < region.x + region.width; x += 1) {
      const a = ((y - top) * cropWidth + (x - left)) * 4, b = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(rendered[a + c]! - whole[b + c]!));
    }
    // Float32 running sums in the box blur start from a different row/column origin in the crop.
    expect(worst).toBeLessThanOrEqual(2);
  });

  it("the vignette is centred on the image, not on the region", () => {
    const settings = { ...defaultCameraRawFilterSettings, vignetteAmount: -80 };
    const width = 200, height = 100, flat = new Uint8ClampedArray(width * height * 4).fill(200);
    const corner = applyCameraRawFilter(flat.subarray(0, 20 * 20 * 4).slice(), 20, 20, settings, { imageWidth: width, imageHeight: height, offsetX: 0, offsetY: 0, scale: 1 });
    const centre = applyCameraRawFilter(flat.subarray(0, 20 * 20 * 4).slice(), 20, 20, settings, { imageWidth: width, imageHeight: height, offsetX: 90, offsetY: 40, scale: 1 });
    expect(corner[0]!).toBeLessThan(centre[0]! - 40);
  });

  it("without a frame it renders exactly as before for everything but grain", () => {
    const width = 64, height = 48, source = photo(width, height), noGrain = { ...everything, grainAmount: 0 };
    expect([...applyCameraRawFilter(source, width, height, noGrain, { imageWidth: width, imageHeight: height, offsetX: 0, offsetY: 0, scale: 1 })]).toEqual([...applyCameraRawFilter(source, width, height, noGrain)]);
  });
});
