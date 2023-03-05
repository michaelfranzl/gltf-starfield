/* SPDX-License-Identifier: GPL-2.0-or-later */
/* SPDX-FileCopyrightText: Copyright 2023 Michael Franzl <public.michael@franzl.name> */

import {
  Document,
  type Material,
  type vec3,
  type vec4,
  WebIO,
} from "npm:@gltf-transform/core";
import { Quat, Vec3 } from "npm:playcanvas";

type starData = [
  id: number,
  rightAscension: number,
  declination: number,
  magnitude: number,
  spectralClass: string,
  name: string,
];

const filename = "bsc5.dat";
const filenameCompressed = filename + ".gz";
const url = `http://tdc-www.harvard.edu/catalogs/${filenameCompressed}`;
const gltfDocument = new Document();
const gltfScene = gltfDocument.createScene();

async function download(): Promise<boolean> {
  console.log("Downloading BSC5 database...");
  const response = await fetch(url);
  if (!response.body) return false;

  const file = await Deno.open(filenameCompressed, {
    write: true,
    create: true,
  });
  await response.body.pipeTo(file.writable);
  return true;
}

async function uncompress(): Promise<void> {
  console.log("Uncompressing BSC5 database...");
  const p = Deno.run({ cmd: ["gunzip", "-q", '-f', filenameCompressed] });
  await p.status()
}

async function compressedInputfileExists(): Promise<boolean> {
  try {
    await Deno.stat(filenameCompressed);
  } catch (_e) {
    return false;
  }
  return true;
}

async function uncompressedInputfileExists(): Promise<boolean> {
  try {
    await Deno.stat(filename);
  } catch (_e) {
    return false;
  }
  return true;
}

function parse(data: string): Array<starData> {
  const lines = data.split("\n");
  const entries: Array<starData> = [];
  let count = 0;
  for (const l of lines) {
    // See http://tdc-www.harvard.edu/catalogs/bsc5.readme
    const bsn = parseInt(l.substring(0, 4)); // a numeric ID

    const name1 = l.substring(4, 13).trim();
    const name2 = l.substring(14, 25).trim();
    const name = `${name1} ${name2}`.trim();

    // right ascension
    const raH = parseFloat(l.substring(75, 77));
    const raM = parseFloat(l.substring(77, 79));
    const raS = parseFloat(l.substring(79, 83));
    const ra = ((raH + raM / 60 + raS / 3600) / 24) * 360;

    // declination
    const deSign = l.substring(83, 84) == "-" ? -1 : 1;
    const deDeg = parseFloat(l.substring(84, 86));
    const deMin = parseFloat(l.substring(86, 88));
    const deSec = parseFloat(l.substring(88, 90));
    const de = deSign * (deDeg + deMin / 60 + deSec / 3600);

    const mag = parseFloat(l.substring(102, 107)); // magnitude
    const st = l.substring(127, 147).trim(); // spectral type
    const sc = st[0]; // spectral class

    if ([bsn, ra, de, mag].some(isNaN)) continue; // skip ~14 non-star objects

    entries[count++] = [bsn, ra, de, mag, sc, name];
  }
  return entries;
}

function createMaterials(): { [s: string]: Material } {
  const starClasses = ["O", "W", "B", "A", "F", "G", "K", "M", "C", "S"];
  return starClasses.reduce((acc, cls) => {
    const mat = gltfDocument.createMaterial();
    const color = spectralClassToColor(cls);
    mat.setEmissiveFactor(color);
    mat.setBaseColorFactor([...color, 1.0]);
    mat.setMetallicFactor(0);
    mat.setRoughnessFactor(1);
    mat.setExtras({ cls })
    acc[cls] = mat;
    return acc;
  }, {} as { [s: string]: Material });
}

function spectralClassToColor(cls: string): vec3 {
  let color = new Array<number>(3) as vec3;

  // Colors taken from the HTML at
  // https://en.wikipedia.org/wiki/Stellar_classification#Harvard_spectral_classification
  switch (cls.toUpperCase()) {
    case "O":
    case "W": // "Wolf-Rayet was once included in 'O'" [Wikipedia]
      color = [0.57, 0.71, 1]; // RGB(146, 181, 255)
      break;
    case "B":
      color = [0.63, 0.75, 1]; // RGB(162, 192, 255)
      break;
    case "A":
      color = [0.83, 0.875, 1]; // RGB(213, 224, 255)
      break;
    case "F":
      color = [0.97, 0.95, 1]; // RGB(249, 245, 255)
      break;
    case "G":
      color = [1, 0.92, 0.88]; // RGB(255, 237, 227)
      break;
    case "K":
      color = [1, 0.85, 0.70]; // RGB(255, 218, 181)
      break;
    case "M":
    case "C": // Carbon red giants
    case "S": // Carbon red giants
      color = [1, 0.70, 0.42]; // RGB(255, 181, 108)
      break;
    default: // N, p, d
      color = [1, 1, 1];
  }

  // Increase the color contrast a bit.
  color[0] = color[0] * color[0];
  color[1] = color[1] * color[1];
  color[2] = color[2] * color[2];

  return color;
}

function render(
  entries: Array<starData>,
  materials: { [s: string]: Material },
) {
  gltfDocument.createBuffer();

  //.Octagon in TRIANGLE_STRIP mode
  // deno-fmt-ignore
  const coords = new Float32Array([
      0 ,  0, 0, // center
     10,   0, 0, // start vertex
      7,   7, 0, // triangle 1
      0,  10, 0,
    - 7,   7, 0,
    -10,   0, 0,
    - 7, - 7, 0,
      0, -10, 0,
      7, - 7, 0,
     10,   0, 0,
  ]).map((n) => n * 0.001)

  const acc = gltfDocument.createAccessor()
    .setType("VEC3")
    .setArray(coords);

  // re-use these for performance
  const q1 = new Quat(); // rotation for right ascension
  const q2 = new Quat(); // rotation for declination
  const q = new Quat(); // combined rotation

  entries.forEach((star) => {
    const [bsn, ra, de, mag, sc, name] = star;

    const mat = materials[sc];

    const prim = gltfDocument.createPrimitive()
      .setAttribute("POSITION", acc)
      .setMaterial(mat)
      .setMode(6); // TRIANGLE_FAN; there is no enum for it

    const mesh = gltfDocument.createMesh()
      .addPrimitive(prim);

    q1.setFromAxisAngle(Vec3.UP, ra);
    q2.setFromAxisAngle(Vec3.RIGHT, de);
    q.mul2(q1, q2);
    const { x, y, z, w } = q;
    const scale = 4 ** ((6 - mag) / 4) / 15;
    const coords = q.transformVector(Vec3.FORWARD);

    // reduce precision to acceptable levels to reduce data size when converted to JSON glTF
    const rotation = [
      parseFloat(x.toFixed(2)),
      parseFloat(y.toFixed(2)),
      parseFloat(z.toFixed(2)),
      parseFloat(w.toFixed(2)),
    ] as vec4;

    const scales = [
      parseFloat(scale.toFixed(2)),
      parseFloat(scale.toFixed(2)),
      parseFloat(scale.toFixed(2)),
    ] as vec3;

    const translation = [
      parseFloat(coords.x.toFixed(3)),
      parseFloat(coords.y.toFixed(3)),
      parseFloat(coords.z.toFixed(3)),
    ] as vec3;

    const node = gltfDocument.createNode()
      .setMesh(mesh)
      .setScale(scales)
      .setRotation(rotation)
      .setTranslation(translation)
      .setExtras({ mag, bsn, name });

    gltfScene.addChild(node);
  });
}

async function main() {
  await uncompressedInputfileExists() ||
    ((await compressedInputfileExists() || await download()) && await uncompress());

  const materials = createMaterials();
  const entries = parse(Deno.readTextFileSync(filename));
  render(entries, materials);

  const binary = await (new WebIO()).writeBinary(gltfDocument);
  Deno.writeFileSync("starfield.glb", binary);
  console.log(`Converted ${entries.length} entries.`)
}

await main();
