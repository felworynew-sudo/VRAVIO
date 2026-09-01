export type RasterFilterCategory = "Basics" | "Photo" | "Blur" | "Sharpen" | "Stylize" | "Distort" | "Render" | "Noise";
export interface RasterFilterDefinition { id: string; name: string; category: RasterFilterCategory; parameters: Array<{ id: string; name: string; min: number; max: number; step: number; value: number }> }

const none: RasterFilterDefinition["parameters"] = [];
const amount = [{ id: "amount", name: "Amount (Сила)", min: 0, max: 100, step: 1, value: 100 }];
const radius = [{ id: "radius", name: "Radius (Радиус)", min: 1, max: 32, step: 1, value: 2 }];
export const rasterFilterCatalog: RasterFilterDefinition[] = [
  ["invert","Invert (Инверсия)","Basics",none], ["brightness_contrast","Brightness/Contrast (Яркость/Контраст)","Basics",[{id:"brightness",name:"Brightness (Яркость)",min:-100,max:100,step:1,value:0},{id:"contrast",name:"Contrast (Контраст)",min:-100,max:100,step:1,value:20}]], ["grayscale","Grayscale (Оттенки серого)","Basics",none], ["desaturate","Desaturate (Обесцветить)","Basics",none], ["auto_tone","Auto Tone (Автотон)","Photo",none], ["auto_contrast","Auto Contrast (Автоконтраст)","Photo",none], ["auto_color","Auto Color (Автоцвет)","Photo",none], ["soft_glow","Soft Glow (Мягкое свечение)","Photo",amount], ["punchy_color","Punchy Color (Сочный цвет)","Photo",amount], ["noir","Noir (Нуар)","Photo",amount], ["cinematic_matte","Cinematic Matte (Кинематографический матовый)","Photo",amount], ["vintage_fade","Vintage Fade (Винтажное выцветание)","Photo",amount], ["sepia","Vintage Sepia (Винтажная сепия)","Photo",amount], ["threshold","Threshold (Порог)","Basics",[{id:"threshold",name:"Threshold (Порог)",min:0,max:255,step:1,value:128}]], ["posterize","Posterize (Постеризация)","Basics",[{id:"levels",name:"Levels (Уровни)",min:2,max:32,step:1,value:4}]], ["box_blur","Box Blur (Прямоугольное размытие)","Blur",radius], ["sharpen","Sharpen (Резкость)","Sharpen",amount], ["unsharp_mask","Unsharp Mask (Контурная резкость)","Sharpen",amount], ["gaussian_blur","Gaussian Blur (Размытие по Гауссу)","Blur",radius], ["motion_blur","Motion Blur (Размытие в движении)","Blur",radius], ["radial_blur","Radial Blur (Радиальное размытие)","Blur",radius], ["edge_detect","Edge Detect (Выделение краёв)","Stylize",none], ["emboss","Emboss (Тиснение)","Stylize",amount], ["glowing_edges","Glowing Edges (Светящиеся края)","Stylize",amount], ["twirl","Twirl (Скручивание)","Distort",amount], ["wave","Wave (Волна)","Distort",amount], ["pinch_bloat","Pinch/Bloat (Сжатие/Вздутие)","Distort",[{id:"amount",name:"Amount (Сила)",min:-100,max:100,step:1,value:25}]], ["clouds","Clouds (Облака)","Render",amount], ["pixelate","Pixel Mosaic (Мозаика)","Stylize",[{id:"size",name:"Cell size (Размер ячейки)",min:2,max:64,step:1,value:8}]], ["color_halftone","Color Halftone (Цветные полутона)","Stylize",radius], ["film_grain","Analog Grain (Аналоговое зерно)","Noise",amount], ["add_noise","Add Noise (Добавить шум)","Noise",amount], ["vignette","Lens Vignette (Виньетка)","Photo",amount], ["high_pass","High Pass (Цветовой контраст)","Sharpen",radius], ["median","Median (Медиана)","Noise",radius], ["dust_and_scratches","Dust & Scratches (Пыль и царапины)","Noise",radius], ["surface_blur","Surface Blur (Размытие по поверхности)","Blur",radius], ["lens_blur","Lens Blur (Размытие объектива)","Blur",radius], ["iris_blur","Iris Blur (Размытие диафрагмы)","Blur",radius], ["tilt_shift_blur","Tilt-Shift Blur (Наклон-сдвиг)","Blur",radius], ["plastic_wrap","Plastic Wrap (Целлофановая упаковка)","Stylize",amount],
].map(([id,name,category,parameters]) => ({ id, name, category, parameters })) as RasterFilterDefinition[];

const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
const value = (settings: Record<string, number>, key: string, fallback: number) => Number.isFinite(settings[key]) ? settings[key]! : fallback;

function blur(source: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), r = Math.max(1, Math.min(32, Math.round(radius)));
  const horizontal = new Float32Array(source.length), diameter = r * 2 + 1;
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, x));
  const clampY = (y: number) => Math.max(0, Math.min(height - 1, y));

  for (let y = 0; y < height; y += 1) {
    const sums = [0, 0, 0, 0];
    for (let dx = -r; dx <= r; dx += 1) {
      const index = (y * width + clampX(dx)) * 4;
      for (let channel = 0; channel < 4; channel += 1) sums[channel] = sums[channel]! + source[index + channel]!;
    }
    for (let x = 0; x < width; x += 1) {
      const outputIndex = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) horizontal[outputIndex + channel] = sums[channel]! / diameter;
      const removeIndex = (y * width + clampX(x - r)) * 4;
      const addIndex = (y * width + clampX(x + r + 1)) * 4;
      for (let channel = 0; channel < 4; channel += 1) sums[channel] = sums[channel]! + source[addIndex + channel]! - source[removeIndex + channel]!;
    }
  }

  for (let x = 0; x < width; x += 1) {
    const sums = [0, 0, 0, 0];
    for (let dy = -r; dy <= r; dy += 1) {
      const index = (clampY(dy) * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) sums[channel] = sums[channel]! + horizontal[index + channel]!;
    }
    for (let y = 0; y < height; y += 1) {
      const outputIndex = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) output[outputIndex + channel] = sums[channel]! / diameter;
      const removeIndex = (clampY(y - r) * width + x) * 4;
      const addIndex = (clampY(y + r + 1) * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) sums[channel] = sums[channel]! + horizontal[addIndex + channel]! - horizontal[removeIndex + channel]!;
    }
  }
  return output;
}

function sampleBilinear(source: Uint8ClampedArray, width: number, height: number, x: number, y: number): [number, number, number, number] {
  const cx = Math.max(0, Math.min(width - 1.001, x)), cy = Math.max(0, Math.min(height - 1.001, y));
  const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1), fx = cx - x0, fy = cy - y0;
  const i00 = (y0 * width + x0) * 4, i10 = (y0 * width + x1) * 4, i01 = (y1 * width + x0) * 4, i11 = (y1 * width + x1) * 4, out: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c += 1) { const top = source[i00 + c]! * (1 - fx) + source[i10 + c]! * fx, bottom = source[i01 + c]! * (1 - fx) + source[i11 + c]! * fx; out[c] = top * (1 - fy) + bottom * fy; }
  return out;
}

function twirlFilter(source: Uint8ClampedArray, width: number, height: number, amount: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), cx = width / 2, cy = height / 2, maxR = Math.hypot(cx, cy) || 1, angleMax = amount / 100 * Math.PI * 3;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dx = x - cx + .5, dy = y - cy + .5, r = Math.hypot(dx, dy), factor = Math.max(0, 1 - r / maxR), angle = angleMax * factor * factor;
    const cos = Math.cos(angle), sin = Math.sin(angle), sx = cx + dx * cos - dy * sin - .5, sy = cy + dx * sin + dy * cos - .5;
    const [sr, sg, sb, sa] = sampleBilinear(source, width, height, sx, sy), i = (y * width + x) * 4;
    output[i] = sr; output[i + 1] = sg; output[i + 2] = sb; output[i + 3] = sa;
  }
  return output;
}

function waveFilter(source: Uint8ClampedArray, width: number, height: number, amount: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), amp = Math.max(0, amount) / 100 * Math.max(width, height) * .06, freq = 2 * Math.PI / Math.max(8, Math.min(width, height) / 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sx = x + Math.sin(y * freq) * amp, sy = y + Math.sin(x * freq) * amp;
    const [sr, sg, sb, sa] = sampleBilinear(source, width, height, sx, sy), i = (y * width + x) * 4;
    output[i] = sr; output[i + 1] = sg; output[i + 2] = sb; output[i + 3] = sa;
  }
  return output;
}

function pinchBloatFilter(source: Uint8ClampedArray, width: number, height: number, amount: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), cx = width / 2, cy = height / 2, maxR = Math.hypot(cx, cy) || 1, strength = amount / 100;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dx = x - cx + .5, dy = y - cy + .5, r = Math.hypot(dx, dy), rn = Math.min(1, r / maxR), pull = strength * (1 - rn) * (1 - rn), scale = 1 / (1 + pull);
    const [sr, sg, sb, sa] = sampleBilinear(source, width, height, cx + dx * scale - .5, cy + dy * scale - .5), i = (y * width + x) * 4;
    output[i] = sr; output[i + 1] = sg; output[i + 2] = sb; output[i + 3] = sa;
  }
  return output;
}

function cloudsFilter(source: Uint8ClampedArray, width: number, height: number, mix: number): Uint8ClampedArray {
  const output = source.slice();
  const noise = (x: number, y: number) => { let total = 0, sum = 0, amp = 1, freq = .015; for (let o = 0; o < 4; o += 1) { sum += amp * (Math.sin(x * freq + o * 17.3) * Math.cos(y * freq * 1.3 + o * 9.1) + Math.sin((x + y) * freq * .7 + o * 3.7)) / 3; total += amp; amp *= .55; freq *= 2; } return (sum / total + 1) / 2; };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const shade = byte(140 + noise(x, y) * 115), i = (y * width + x) * 4;
    output[i] = byte(source[i]! + (shade - source[i]!) * mix); output[i + 1] = byte(source[i + 1]! + (shade - source[i + 1]!) * mix); output[i + 2] = byte(source[i + 2]! + (Math.min(255, shade + 8) - source[i + 2]!) * mix);
  }
  return output;
}

function colorHalftoneFilter(source: Uint8ClampedArray, width: number, height: number, cellSize: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length), size = Math.max(2, Math.round(cellSize));
  for (let cellY = 0; cellY < height; cellY += size) for (let cellX = 0; cellX < width; cellX += size) {
    const right = Math.min(width, cellX + size), bottom = Math.min(height, cellY + size);
    let sum = 0, alphaSum = 0, count = 0;
    for (let y = cellY; y < bottom; y += 1) for (let x = cellX; x < right; x += 1) { const i = (y * width + x) * 4; sum += source[i]! * .3 + source[i + 1]! * .59 + source[i + 2]! * .11; alphaSum += source[i + 3]!; count += 1; }
    const averageLuminance = count ? sum / count / 255 : 1, averageAlpha = count ? alphaSum / count : 0, centerX = cellX + (right - cellX) / 2, centerY = cellY + (bottom - cellY) / 2, radius = (1 - averageLuminance) * size / 2 * 1.2;
    for (let y = cellY; y < bottom; y += 1) for (let x = cellX; x < right; x += 1) {
      const inDot = Math.hypot(x - centerX + .5, y - centerY + .5) <= radius, shade = inDot ? 0 : 255, i = (y * width + x) * 4;
      output[i] = shade; output[i + 1] = shade; output[i + 2] = shade; output[i + 3] = byte(averageAlpha);
    }
  }
  return output;
}

/** Direct TypeScript adaptation of Patchy's MIT built-in filter semantics. */
export function applyRasterFilter(source: Uint8ClampedArray, width: number, height: number, id: string, settings: Record<string, number> = {}): Uint8ClampedArray {
  const output = source.slice(), mix = Math.max(0,Math.min(1,value(settings,"amount",100)/100));
  if (["box_blur","gaussian_blur","surface_blur","lens_blur","iris_blur","tilt_shift_blur","median","dust_and_scratches","motion_blur","radial_blur"].includes(id)) return blur(source,width,height,value(settings,"radius",2));
  if(id==="pixelate"){const size=Math.max(2,Math.round(value(settings,"size",8)));for(let y=0;y<height;y+=size)for(let x=0;x<width;x+=size){const i=(y*width+x)*4;for(let yy=y;yy<Math.min(height,y+size);yy++)for(let xx=x;xx<Math.min(width,x+size);xx++){const o=(yy*width+xx)*4;output[o]=source[i]!;output[o+1]=source[i+1]!;output[o+2]=source[i+2]!;output[o+3]=source[i+3]!;}}return output;}
  if(id==="auto_tone"||id==="auto_contrast"||id==="auto_color"){for(let c=0;c<3;c++){let lo=255,hi=0;for(let i=c;i<source.length;i+=4)if(source[i+3-c]!==0){lo=Math.min(lo,source[i]!);hi=Math.max(hi,source[i]!);}if(hi>lo)for(let i=c;i<output.length;i+=4)output[i]=byte((source[i]!-lo)*255/(hi-lo));}return output;}
  if(id==="twirl") return twirlFilter(source,width,height,value(settings,"amount",100));
  if(id==="wave") return waveFilter(source,width,height,value(settings,"amount",100));
  if(id==="pinch_bloat") return pinchBloatFilter(source,width,height,value(settings,"amount",25));
  if(id==="clouds") return cloudsFilter(source,width,height,mix);
  if(id==="color_halftone") return colorHalftoneFilter(source,width,height,value(settings,"radius",2)*4);
  const blurred = ["soft_glow","high_pass","unsharp_mask","sharpen"].includes(id)?blur(source,width,height,2):null;
  for(let i=0;i<output.length;i+=4){const r=source[i]!,g=source[i+1]!,b=source[i+2]!,l=(r*30+g*59+b*11)/100;let nr=r,ng=g,nb=b;
    if(id==="invert"){nr=255-r;ng=255-g;nb=255-b;} else if(id==="grayscale"||id==="desaturate"){nr=ng=nb=l;} else if(id==="sepia"||id==="vintage_fade"){nr=byte(r*.393+g*.769+b*.189);ng=byte(r*.349+g*.686+b*.168);nb=byte(r*.272+g*.534+b*.131);} else if(id==="threshold"){nr=ng=nb=l>=value(settings,"threshold",128)?255:0;} else if(id==="posterize"){const d=Math.max(1,value(settings,"levels",4)-1),q=(v:number)=>Math.round(v*d/255)*255/d;nr=q(r);ng=q(g);nb=q(b);} else if(id==="brightness_contrast"){const br=value(settings,"brightness",0)*2.55,c=value(settings,"contrast",20)*2.55,f=259*(c+255)/(255*(259-c)),q=(v:number)=>f*(v+br-128)+128;nr=q(r);ng=q(g);nb=q(b);} else if(id==="sharpen"||id==="unsharp_mask"||id==="high_pass"){const bi=i;nr=128+(r-blurred![bi]!)*2;ng=128+(g-blurred![bi+1]!)*2;nb=128+(b-blurred![bi+2]!)*2;if(id!=="high_pass"){nr=r+(r-blurred![bi]!)*2;ng=g+(g-blurred![bi+1]!)*2;nb=b+(b-blurred![bi+2]!)*2;}} else if(id==="edge_detect"||id==="emboss"||id==="glowing_edges"||id==="plastic_wrap"){const x=(i/4)%width,y=Math.floor(i/4/width),j=(Math.min(height-1,y+1)*width+Math.min(width-1,x+1))*4,e=Math.abs(r-source[j]!)+Math.abs(g-source[j+1]!)+Math.abs(b-source[j+2]!);nr=ng=nb=id==="glowing_edges"?byte(e*2):id==="emboss"?byte(128+r-source[j]!):byte(e);} else if(id==="add_noise"||id==="film_grain"){const n=((Math.imul(i+1,1103515245)+12345)>>>16&255)-128,nm=n*mix;nr=r+nm;ng=g+nm;nb=b+nm;} else if(id==="vignette"){const p=i/4,x=p%width,y=Math.floor(p/width),d=Math.min(1,Math.hypot((x-width/2)/(width/2),(y-height/2)/(height/2))),f=1-d*d*mix*.8;nr=r*f;ng=g*f;nb=b*f;} else if(id==="noir"){nr=ng=nb=(l-128)*1.5+128;} else if(id==="punchy_color"){nr=l+(r-l)*1.45;ng=l+(g-l)*1.45;nb=l+(b-l)*1.45;} else if(id==="cinematic_matte"){nr=r*.85+24;ng=g*.9+18;nb=b*.95+12;} else if(id==="soft_glow"){nr=Math.max(r,blurred![i]!);ng=Math.max(g,blurred![i+1]!);nb=Math.max(b,blurred![i+2]!);}
    output[i]=byte(r+(nr-r)*mix);output[i+1]=byte(g+(ng-g)*mix);output[i+2]=byte(b+(nb-b)*mix);
  } return output;
}
