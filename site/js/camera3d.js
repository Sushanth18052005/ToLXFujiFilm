// camera3d.js — procedural Fujifilm X100-style rangefinder, scroll-driven.
// Built from primitives so it ships with no binary model yet still reads as a
// premium object: PBR metal/glass, RoomEnvironment reflections, ACES tone map.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- geometry helpers ----
// Per-corner rounded rectangle centred on the origin (radii: top-l/r, bottom-r/l).
function rrShape(w, h, tl, tr, br, bl) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + bl, y);
  s.lineTo(x + w - br, y);
  if (br) s.absarc(x + w - br, y + br, br, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - tr);
  if (tr) s.absarc(x + w - tr, y + h - tr, tr, 0, Math.PI / 2, false);
  s.lineTo(x + tl, y + h);
  if (tl) s.absarc(x + tl, y + h - tl, tl, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + bl);
  if (bl) s.absarc(x + bl, y + bl, bl, Math.PI, Math.PI * 1.5, false);
  return s;
}

function extrude(shape, depth) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: 0.012,
    bevelSize: 0.012, bevelSegments: 3, curveSegments: 32,
  });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
}

// Vertical-stripe bump — fakes the knurl on dials and the aperture ring.
function knurlTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 16;
  const x = c.getContext('2d');
  for (let i = 0; i < 256; i += 4) { x.fillStyle = i % 8 === 0 ? '#fff' : '#000'; x.fillRect(i, 0, 4, 16); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(28, 1);
  return t;
}
// Fine grain — a soft bump for the black leatherette body wrap.
function leatherTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#808080'; x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const v = 96 + Math.random() * 80;
    x.fillStyle = `rgb(${v},${v},${v})`;
    x.fillRect(Math.random() * 256, Math.random() * 256, 1.6, 1.6);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 2);
  return t;
}

// "FUJIFILM" wordmark, dark on transparent, sits on the silver top plate.
function logoTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 512, 128);
  x.fillStyle = '#141416';
  x.font = '800 72px Archivo, Arial, sans-serif';
  x.textBaseline = 'middle'; x.textAlign = 'center';
  x.fillText('FUJIFILM', 256, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// ---- assemble the camera as one Group ----
function buildCamera() {
  const cam = new THREE.Group();

  const black = new THREE.MeshStandardMaterial({
    color: 0x161618, roughness: 0.82, metalness: 0.15,
    bumpMap: leatherTexture(), bumpScale: 0.01,
  });
  const silver = new THREE.MeshStandardMaterial({
    color: 0xcfd2d6, roughness: 0.3, metalness: 1.0, envMapIntensity: 1.15,
  });
  const knurlMat = new THREE.MeshStandardMaterial({
    color: 0xbcbfc4, roughness: 0.42, metalness: 1.0,
    bumpMap: knurlTexture(), bumpScale: 0.02,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x0a1016, metalness: 0, roughness: 0.04,
    clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.7, reflectivity: 1,
  });
  const W = 1.55, HB = 0.66, HT = 0.22, D = 0.44, r = 0.075;
  const H = HB + HT;

  // body (black leatherette) — square top, rounded bottom
  const body = new THREE.Mesh(extrude(rrShape(W, HB, 0, 0, r, r), D), black);
  body.position.y = -H / 2 + HB / 2; cam.add(body);
  // top plate (silver) — rounded top corners
  const top = new THREE.Mesh(extrude(rrShape(W, HT, r, r, 0, 0), D * 0.98), silver);
  top.position.y = H / 2 - HT / 2; cam.add(top);
  // base plate accent
  const base = new THREE.Mesh(extrude(rrShape(W, 0.055, 0, 0, r, r), D * 0.98), silver);
  base.position.y = -H / 2 + 0.028; cam.add(base);

  const front = D / 2;

  // ---- fixed prime lens ----
  const lens = new THREE.Group();
  lens.position.set(-0.04, -0.06, front);
  const ring = (rad, len, mat, z) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len, 64), mat);
    m.rotation.x = Math.PI / 2; m.position.z = z + len / 2; return m;
  };
  let z = 0;
  lens.add(ring(0.205, 0.05, silver, z)); z += 0.05;
  lens.add(ring(0.188, 0.13, black, z)); z += 0.13;
  lens.add(ring(0.202, 0.07, knurlMat, z)); z += 0.07;   // aperture ring
  lens.add(ring(0.18, 0.06, black, z)); z += 0.06;
  lens.add(ring(0.192, 0.03, silver, z)); z += 0.03;
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.158, 64), glassMat);
  glass.position.z = z + 0.002; lens.add(glass);
  const inner = new THREE.Mesh(new THREE.CircleGeometry(0.1, 48),
    new THREE.MeshPhysicalMaterial({ color: 0x061c26, roughness: 0.02, metalness: 0, clearcoat: 1, envMapIntensity: 2.2 }));
  inner.position.z = z + 0.004; lens.add(inner);
  const glint = new THREE.Mesh(new THREE.CircleGeometry(0.028, 24), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  glint.position.set(-0.05, 0.055, z + 0.006); lens.add(glint);
  cam.add(lens);
  // ---- top-plate details ----
  const dial = (x, rad, len) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len, 48), knurlMat);
    m.position.set(x, H / 2 + len / 2 - 0.008, -0.03); return m;
  };
  cam.add(dial(0.34, 0.12, 0.085));   // shutter-speed dial
  cam.add(dial(0.6, 0.1, 0.07));      // exposure-comp dial
  const shutter = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.05, 32), silver);
  shutter.position.set(0.34, H / 2 + 0.1, -0.03); cam.add(shutter);
  const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.14), silver);
  shoe.position.set(0, H / 2 + 0.022, -0.02); cam.add(shoe);
  // optical viewfinder window, front top-left
  const vf = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.11, 0.03), glassMat);
  vf.position.set(-0.52, 0.14, front - 0.01); cam.add(vf);
  // FUJIFILM wordmark
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.115),
    new THREE.MeshBasicMaterial({ map: logoTexture(), transparent: true }));
  logo.position.set(-0.32, 0.3, front + 0.01); cam.add(logo);

  return cam;
}

// ---- renderer / scene / scroll-driven loop ----
export function createCamera3D(canvas) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) { throw new Error('webgl-unavailable'); }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 0, 4.3);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(3, 4, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcd0ff, 1.4); rim.position.set(-4, 1.5, -3); scene.add(rim);
  const warm = new THREE.PointLight(0xffd9a8, 14, 24); warm.position.set(-2, -1, 3); scene.add(warm);
  scene.add(new THREE.AmbientLight(0x2a2a30, 0.6));
  const rig = new THREE.Group();
  rig.add(buildCamera());
  scene.add(rig);

  // damped motion state; targets come from scroll progress + pointer.
  const cur = { rx: 0.12, ry: -0.55, px: 1.15, py: 0.06, cz: 4.3, s: 1.0 };
  let progress = 0, pnx = 0, pny = 0, intro = 0, t0 = performance.now();

  // three anchors interpolated with smoothstep: hero → statement → product.
  const A = { rx: 0.12, ry: -0.55, px: 1.15, py: 0.06, cz: 4.3, s: 1.0 };
  const B = { rx: 0.05, ry: 0.4, px: 0.98, py: -0.5, cz: 4.7, s: 0.9 };
  const C = { rx: 0.15, ry: -0.38, px: 0.0, py: -0.02, cz: 3.35, s: 1.12 };
  const ss = (u) => u * u * (3 - 2 * u);
  function targetFor(p) {
    const o = {}, mix = (a, b, u) => a + (b - a) * u;
    if (p < 0.5) { const u = ss(p / 0.5); for (const k in A) o[k] = mix(A[k], B[k], u); }
    else { const u = ss((p - 0.5) / 0.5); for (const k in B) o[k] = mix(B[k], C[k], u); }
    return o;
  }

  let spread = 1, farBoost = 0;
  function resize() {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    if (w < 2 || h < 2) return; // not laid out yet — the ResizeObserver re-fires us
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    spread = Math.min(1, Math.max(0.16, camera.aspect / 1.6)); // centre on narrow screens
    farBoost = (1 - spread) * 1.8;                              // and pull back to fit
  }
  resize();
  // React to the canvas actually getting (or changing) size, not just window resize.
  if ('ResizeObserver' in window) { new ResizeObserver(() => resize()).observe(canvas); }

  let raf;
  function frame() {
    raf = requestAnimationFrame(frame);
    const t = (performance.now() - t0) / 1000;
    if (intro < 1) intro = Math.min(1, intro + 0.012);
    const eI = ss(intro);
    const tg = targetFor(progress);
    const sway = REDUCED ? 0 : Math.sin(t * 0.45) * 0.04;
    const k = REDUCED ? 0.2 : 0.075;
    cur.rx += ((tg.rx - (REDUCED ? 0 : pny * 0.12)) - cur.rx) * k;
    cur.ry += ((tg.ry + (REDUCED ? 0 : pnx * 0.18) + sway) - cur.ry) * k;
    cur.px += (tg.px * spread - cur.px) * k;
    cur.py += (tg.py - cur.py) * k;
    cur.cz += (tg.cz - cur.cz) * k;
    cur.s += (tg.s - cur.s) * k;
    rig.rotation.set(cur.rx, cur.ry, 0);
    rig.position.set(cur.px, cur.py, 0);
    rig.scale.setScalar(cur.s * (0.9 + 0.1 * eI));
    camera.position.z = cur.cz + farBoost + (1 - eI) * 1.6;
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }
  frame();

  return {
    setProgress(p) { progress = Math.max(0, Math.min(1, p)); },
    setPointer(nx, ny) { pnx = nx; pny = ny; },
    resize,
    dispose() { cancelAnimationFrame(raf); renderer.dispose(); pmrem.dispose(); },
  };
}
