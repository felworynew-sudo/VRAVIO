import { describe, expect, it } from "vitest";
import { spaceZoomFrom } from "./RasterWorkspace";

const keys = (held: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }>) =>
  ({ metaKey: false, ctrlKey: false, altKey: false, ...held });

describe("space bar as a zoom tool", () => {
  it("leaves space on its own as the hand tool", () => {
    expect(spaceZoomFrom(keys({}))).toBeNull();
  });

  it("zooms in with the platform key", () => {
    expect(spaceZoomFrom(keys({ metaKey: true }))).toBe("in");
    expect(spaceZoomFrom(keys({ ctrlKey: true }))).toBe("in");
  });

  it("zooms out with Option on macOS and Ctrl+Alt on Windows", () => {
    // Both spellings are accepted rather than sniffing the platform; neither
    // collides with anything else on the canvas.
    expect(spaceZoomFrom(keys({ altKey: true }))).toBe("out");
    expect(spaceZoomFrom(keys({ ctrlKey: true, altKey: true }))).toBe("out");
    expect(spaceZoomFrom(keys({ metaKey: true, altKey: true }))).toBe("out");
  });
});
