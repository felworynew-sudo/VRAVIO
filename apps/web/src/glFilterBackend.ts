import { filterPassCount, type FilterParams, type FilterSpec } from "@vravio/env-raster";

const VERTEX_SOURCE = `#version 300 es
in vec2 position;
out vec2 texCoord;
void main() {
  texCoord = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

function fragmentSource(body: string, uniformNames: readonly string[], vectorNames: readonly string[]): string {
  const declarations = uniformNames.map((name) => `uniform ${vectorNames.includes(name) ? "vec2" : "float"} ${name};`).join("\n");
  return `#version 300 es
precision highp float;
uniform sampler2D sourceTexture;
uniform vec2 texelSize;
${declarations}
in vec2 texCoord;
out vec4 fragColor;
${body}
void main() { fragColor = filterPixel(texture(sourceTexture, texCoord)); }`;
}

interface CompiledProgram { program: WebGLProgram; uniforms: Map<string, WebGLUniformLocation | null> }

/**
 * WebGL2 filter backend: two textures, render from one into the other, swap.
 *
 * Two caches make the difference between this and a naive implementation. Programs compile
 * once per shader rather than per invocation, and the source texture uploads once per cache
 * key rather than on every slider movement — otherwise dragging a slider re-uploads the whole
 * image dozens of times a second.
 */
export class GlFilterBackend {
  readonly #canvas: HTMLCanvasElement;
  readonly #gl: WebGL2RenderingContext;
  readonly #programs = new Map<string, CompiledProgram>();
  readonly #textureCache = new Map<string, { texture: WebGLTexture; width: number; height: number }>();
  #quad: WebGLBuffer | null = null;
  #framebuffer: WebGLFramebuffer | null = null;
  #disposed = false;

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.#canvas = canvas;
    this.#gl = gl;
  }

  /** Returns null when WebGL2 is unavailable, so callers fall back to the CPU path. */
  static create(): GlFilterBackend | null {
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: false });
    return gl ? new GlFilterBackend(canvas, gl) : null;
  }

  get isDisposed(): boolean { return this.#disposed; }
  get cachedPrograms(): number { return this.#programs.size; }
  get cachedTextures(): number { return this.#textureCache.size; }

  releaseTexture(cacheKey: string): void {
    const cached = this.#textureCache.get(cacheKey);
    if (!cached) return;
    this.#gl.deleteTexture(cached.texture);
    this.#textureCache.delete(cacheKey);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const gl = this.#gl;
    for (const compiled of this.#programs.values()) gl.deleteProgram(compiled.program);
    for (const cached of this.#textureCache.values()) gl.deleteTexture(cached.texture);
    this.#programs.clear();
    this.#textureCache.clear();
    if (this.#quad) gl.deleteBuffer(this.#quad);
    if (this.#framebuffer) gl.deleteFramebuffer(this.#framebuffer);
  }

  /**
   * Runs one filter over RGBA pixels and returns the result, or null when the spec has no
   * shader or the GPU path fails — the caller then uses `spec.cpu`.
   */
  apply<P extends FilterParams>(spec: FilterSpec<P>, pixels: Uint8ClampedArray, width: number, height: number, params: P, cacheKey?: string): Uint8ClampedArray | null {
    const glsl = spec.gpu?.glsl;
    if (this.#disposed || !glsl || width <= 0 || height <= 0) return null;
    const gl = this.#gl;
    try {
      this.#resize(width, height);
      const passes = filterPassCount(spec, params);
      let source = this.#uploadSource(pixels, width, height, cacheKey);
      const ping = this.#createTarget(width, height);
      const pong = passes > 1 ? this.#createTarget(width, height) : null;
      let target = ping;

      for (let pass = 0; pass < passes; pass += 1) {
        const uniforms = spec.gpu!.uniforms(params, pass);
        const compiled = this.#program(spec.id, glsl, uniforms);
        gl.useProgram(compiled.program);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.#ensureFramebuffer());
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
        gl.viewport(0, 0, width, height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, source);
        gl.uniform1i(compiled.uniforms.get("sourceTexture") ?? null, 0);
        gl.uniform2f(compiled.uniforms.get("texelSize") ?? null, 1 / width, 1 / height);
        for (const [name, value] of Object.entries(uniforms)) {
          const location = compiled.uniforms.get(name) ?? null;
          if (Array.isArray(value)) gl.uniform2f(location, value[0] ?? 0, value[1] ?? 0);
          else gl.uniform1f(location, value as number);
        }
        this.#drawQuad(compiled.program);
        // Ping-pong: this pass's output becomes the next pass's input.
        if (pass < passes - 1 && pong) {
          source = target;
          target = target === ping ? pong : ping;
        }
      }

      const output = new Uint8ClampedArray(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, output);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteTexture(ping);
      if (pong) gl.deleteTexture(pong);
      // No row flipping anywhere: the quad maps framebuffer row 0 (which readPixels returns
      // first) to texture row 0, so document order survives the round trip untouched. Flipping
      // on both upload and readback would cancel out at the cost of two full-image copies.
      return output;
    } catch {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return null;
    }
  }

  #resize(width: number, height: number): void {
    if (this.#canvas.width !== width) this.#canvas.width = width;
    if (this.#canvas.height !== height) this.#canvas.height = height;
  }

  #ensureFramebuffer(): WebGLFramebuffer {
    this.#framebuffer ??= this.#gl.createFramebuffer();
    return this.#framebuffer!;
  }

  #uploadSource(pixels: Uint8ClampedArray, width: number, height: number, cacheKey?: string): WebGLTexture {
    const cached = cacheKey ? this.#textureCache.get(cacheKey) : undefined;
    if (cached && cached.width === width && cached.height === height) return cached.texture;
    const texture = this.#createTarget(width, height, pixels);
    if (cacheKey) {
      const stale = this.#textureCache.get(cacheKey);
      if (stale) this.#gl.deleteTexture(stale.texture);
      this.#textureCache.set(cacheKey, { texture, width, height });
    }
    return texture;
  }

  #createTarget(width: number, height: number, pixels?: Uint8ClampedArray): WebGLTexture {
    const gl = this.#gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const data = pixels ? new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength) : null;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return texture;
  }

  #program(id: string, glsl: string, uniforms: Record<string, number | readonly number[]>): CompiledProgram {
    const cached = this.#programs.get(id);
    if (cached) return cached;
    const gl = this.#gl;
    const names = Object.keys(uniforms);
    const vectors = names.filter((name) => Array.isArray(uniforms[name]));
    const program = linkProgram(gl, VERTEX_SOURCE, fragmentSource(glsl, names, vectors));
    const locations = new Map<string, WebGLUniformLocation | null>();
    for (const name of [...names, "sourceTexture", "texelSize"]) locations.set(name, gl.getUniformLocation(program, name));
    const compiled = { program, uniforms: locations };
    this.#programs.set(id, compiled);
    return compiled;
  }

  #drawQuad(program: WebGLProgram): void {
    const gl = this.#gl;
    if (!this.#quad) {
      this.#quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#quad);
    const location = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

function linkProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Could not create shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? "unknown";
      gl.deleteShader(shader);
      throw new Error(`Shader failed to compile: ${log}`);
    }
    return shader;
  };
  const program = gl.createProgram();
  if (!program) throw new Error("Could not create program");
  const vertexShader = compile(gl.VERTEX_SHADER, vertex), fragmentShader = compile(gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown";
    gl.deleteProgram(program);
    throw new Error(`Program failed to link: ${log}`);
  }
  return program;
}

let shared: GlFilterBackend | null | undefined;

/** One backend per application: browsers cap the number of live WebGL contexts. */
export function sharedGlFilterBackend(): GlFilterBackend | null {
  if (shared === undefined) shared = GlFilterBackend.create();
  return shared;
}
