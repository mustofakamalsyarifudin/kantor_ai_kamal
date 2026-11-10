import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Agent } from "../lib/api";

const ZONES = [
  { code: "strategy", label: "STRATEGY HUB", x: -18, z: -10, color: "#e8eadb", icon: "✦" },
  { code: "creative", label: "CREATIVE STUDIO", x: -6, z: -10, color: "#f1dfca", icon: "▣" },
  { code: "analytics", label: "ANALYTICS LAB", x: 6, z: -10, color: "#deddf1", icon: "▥" },
  { code: "finance", label: "FINANCE DESK", x: 18, z: -10, color: "#d9e8db", icon: "＄" },
  { code: "engineering", label: "ENGINEERING BAY", x: -18, z: 0, color: "#dce8f1", icon: "⌘" },
  { code: "research", label: "RESEARCH LAB", x: -6, z: 0, color: "#e9dff0", icon: "⌕" },
  { code: "design", label: "PRODUCT DESIGN", x: 6, z: 0, color: "#f0dfe5", icon: "✎" },
  { code: "support", label: "CLIENT SUPPORT", x: 18, z: 0, color: "#f0e7cf", icon: "◉" },
  { code: "meeting", label: "WAR ROOM", x: -18, z: 10, color: "#e6e9dc", icon: "◌" },
  { code: "pantry", label: "PANTRY & BREAK", x: -6, z: 10, color: "#f0e2d2", icon: "☕" },
  { code: "lounge", label: "COLLAB LOUNGE", x: 6, z: 10, color: "#dcebe4", icon: "▱" },
  { code: "focus", label: "FOCUS PODS", x: 18, z: 10, color: "#e0e5ef", icon: "◎" }
];
const palette = ["#ca826c", "#7195c4", "#d5ac5a", "#62a990", "#bc7e9f", "#8c80bc", "#5e9ca8", "#829c68"];
const defaultDepartments: Record<string, string> = { nara: "strategy", bima: "analytics", sinta: "finance", dika: "creative", maya: "creative", raka: "research" };
const departmentForAgent = (agent: Agent) => agent.department?.code || (agent as Agent & { departmentCode?: string }).departmentCode || defaultDepartments[agent.slug] || "strategy";
const zoneFor = (code: string) => ZONES.find((zone) => zone.code === code) || ZONES[0];

type Actor = { group: THREE.Group; id: string; zoneCode: string; shirt: THREE.MeshStandardMaterial; phase: number; moving: boolean; target?: THREE.Vector3; targetZoneCode?: string; path: THREE.Vector3[]; pathIndex: number; speed: number; limbs: THREE.Object3D[]; state: string };

function makeBox(scene: THREE.Scene, x: number, y: number, z: number, sx: number, sy: number, sz: number, color: THREE.ColorRepresentation, opts: { roughness?: number; metalness?: number; transparent?: boolean; opacity?: number } = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), new THREE.MeshStandardMaterial({ color, roughness: opts.roughness ?? .8, metalness: opts.metalness ?? 0, transparent: opts.transparent ?? false, opacity: opts.opacity ?? 1 }));
  mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; scene.add(mesh); return mesh;
}
function makeFloorTexture() {
  const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 512;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#c5a37d"; ctx.fillRect(0, 0, 512, 512);
  const rowHeight = 64;
  for (let row = 0; row < 8; row++) {
    const offset = row % 2 ? -100 : 0;
    for (let col = -1; col < 4; col++) {
      const x = col * 150 + offset;
      const hue = 28 + ((row * 5 + col * 3) % 8);
      ctx.fillStyle = `hsl(${hue},38%,${52 + ((row + col) % 4) * 2}%)`;
      ctx.fillRect(x + 2, row * rowHeight + 2, 146, rowHeight - 4);
      ctx.fillStyle = "rgba(255,255,255,.15)"; ctx.fillRect(x + 6, row * rowHeight + 4, 137, 2);
      ctx.fillStyle = "rgba(75,51,30,.16)"; ctx.fillRect(x + 2, row * rowHeight + rowHeight - 3, 146, 2);
      for (let n = 0; n < 10; n++) { ctx.fillStyle = "rgba(92,65,37,.045)"; ctx.fillRect(x + 12 + n * 13, row * rowHeight + 8, 1, rowHeight - 18); }
    }
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(2, 2); return texture;
}
function createOfficeFurniture(scene: THREE.Scene, zone: typeof ZONES[number]) {
  const rug = new THREE.Mesh(new THREE.BoxGeometry(10.6, .06, 7.6), new THREE.MeshStandardMaterial({ color: zone.color, roughness: .95 }));
  rug.position.set(zone.x, .065, zone.z); rug.receiveShadow = true; scene.add(rug);
  const deskMat = new THREE.MeshStandardMaterial({ color: "#c5a17b", roughness: .72 });
  const legMat = new THREE.MeshStandardMaterial({ color: "#80684e", roughness: .7 });
  const screenMat = new THREE.MeshStandardMaterial({ color: "#2d4651", roughness: .22, metalness: .12, emissive: "#214a54", emissiveIntensity: .38 });
  const deskPositions: [number, number][] = zone.code === "meeting" || zone.code === "lounge" || zone.code === "pantry" ? [] : zone.code === "focus" ? [[zone.x - 1.9, zone.z - 1.35], [zone.x + 1.9, zone.z - 1.35]] : ["engineering", "creative", "analytics", "finance", "support", "design"].includes(zone.code) ? [[zone.x - 1.9, zone.z - 1.25], [zone.x + 1.9, zone.z - 1.25]] : [[zone.x - 1.9, zone.z - 1.3]];
  for (const [dx, dz] of deskPositions) {
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.75, .18, .95), deskMat); top.position.set(dx, .92, dz); top.castShadow = true; top.receiveShadow = true; scene.add(top);
    for (const ox of [-.72, .72]) for (const oz of [-.36, .36]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(.09, .9, .09), legMat); leg.position.set(dx + ox, .45, dz + oz); leg.castShadow = true; scene.add(leg); }
    const monitor = new THREE.Mesh(new THREE.BoxGeometry(.65, .5, .08), new THREE.MeshStandardMaterial({ color: "#aabbb2", roughness: .45 })); monitor.position.set(dx, 1.3, dz - .18); monitor.castShadow = true; scene.add(monitor);
    const screen = new THREE.Mesh(new THREE.BoxGeometry(.54, .37, .022), screenMat); screen.position.set(dx, 1.31, dz - .132); scene.add(screen);
    const stand = new THREE.Mesh(new THREE.BoxGeometry(.08, .18, .07), legMat); stand.position.set(dx, 1.02, dz - .17); scene.add(stand);
    const chair = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.BoxGeometry(.6, .15, .6), new THREE.MeshStandardMaterial({ color: "#6c9885", roughness: .8 })); seat.position.y = .57; seat.castShadow = true; chair.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(.58, .6, .13), new THREE.MeshStandardMaterial({ color: "#81a894", roughness: .84 })); back.position.set(0, .86, .27); back.castShadow = true; chair.add(back);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, .45, 8), legMat); base.position.y = .28; chair.add(base);
    chair.position.set(dx, 0, dz + .9); scene.add(chair);
  }
  if (zone.code === "meeting") {
    const table = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, .25, 32), new THREE.MeshStandardMaterial({ color: "#b7c8b6", roughness: .52 })); table.position.set(zone.x, .85, zone.z - .35); table.castShadow = true; scene.add(table);
    const base = makeBox(scene, zone.x, .42, zone.z - .35, .35, .75, .35, "#8fa58f"); base.castShadow = true;
    for (let i = 0; i < 6; i++) { const angle = Math.PI * 2 * i / 6; const seat = new THREE.Mesh(new THREE.BoxGeometry(.62, .14, .6), new THREE.MeshStandardMaterial({ color: "#708e7d" })); seat.position.set(zone.x + Math.cos(angle) * 2.65, .57, zone.z - .35 + Math.sin(angle) * 2.2); seat.castShadow = true; scene.add(seat); }
    const board = makeBox(scene, zone.x, 2, zone.z - 3.12, 3.5, 1.4, .12, "#a8beb1"); board.material = new THREE.MeshStandardMaterial({ color: "#e7f0e8", roughness: .72 });
  }
  if (zone.code === "pantry") {
    makeBox(scene, zone.x - 2.6, .72, zone.z - 1, 1.2, 1.45, 1.1, "#b4bfba");
    makeBox(scene, zone.x + .9, .52, zone.z + .2, 1.3, .15, 1.2, "#bb9168");
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(.14, .12, .25, 16), new THREE.MeshStandardMaterial({ color: "#f9f3df" })); cup.position.set(zone.x + .6, .72, zone.z + .2); scene.add(cup);
  }
  if (zone.code === "lounge") {
    makeBox(scene, zone.x - 1.5, .55, zone.z - .2, 2.7, .8, 1, "#7fa090");
    makeBox(scene, zone.x - 1.5, .98, zone.z - .63, 2.7, .2, .18, "#aec5b7");
    makeBox(scene, zone.x + 1.4, .45, zone.z - .1, 1.1, .12, .75, "#b88f68");
  }
  if (["research", "finance"].includes(zone.code)) {
    const cupboard = new THREE.Mesh(new THREE.BoxGeometry(.7, 1.8, .65), new THREE.MeshStandardMaterial({ color: "#917250", roughness: .86 })); cupboard.position.set(zone.x + 4.1, .92, zone.z - 1.15); cupboard.castShadow = true; scene.add(cupboard);
    for (let y = .55; y < 1.8; y += .42) makeBox(scene, zone.x + 3.73, y, zone.z - .81, .04, .035, .04, "#dec69d");
  }
  if (!["meeting", "pantry", "lounge"].includes(zone.code)) {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(.27, .32, .45, 12), new THREE.MeshStandardMaterial({ color: "#b88c69", roughness: .9 })); pot.position.set(zone.x + 4.1, .24, zone.z + 2.65); pot.castShadow = true; scene.add(pot);
    for (let leaf = 0; leaf < 6; leaf++) { const mesh = new THREE.Mesh(new THREE.SphereGeometry(.24, 10, 7), new THREE.MeshStandardMaterial({ color: leaf % 2 ? "#67a97b" : "#3f875f", roughness: .95 })); const angle = leaf * Math.PI / 3; mesh.scale.set(.8, 1.7, .7); mesh.position.set(zone.x + 4.1 + Math.cos(angle) * .28, .64 + (leaf % 2) * .08, zone.z + 2.65 + Math.sin(angle) * .28); mesh.castShadow = true; scene.add(mesh); }
  }
}

function createCharacter(agent: Agent, index: number): Actor {
  const group = new THREE.Group();
  const shirt = new THREE.MeshStandardMaterial({ color: (agent.visualConfig?.shirt as string) || palette[index % palette.length], roughness: .8 });
  const skin = new THREE.MeshStandardMaterial({ color: (agent.visualConfig?.skin as string) || "#d7a17e", roughness: .86 });
  const pants = new THREE.MeshStandardMaterial({ color: (agent.visualConfig?.pants as string) || "#4b5a68", roughness: .92 });
  const hair = new THREE.MeshStandardMaterial({ color: (agent.visualConfig?.hair as string) || "#43352f", roughness: .93 });
  const white = new THREE.MeshStandardMaterial({ color: "#f6f2e7", roughness: .72 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(.27, .42, 4, 9), shirt); torso.position.y = 1.04; torso.castShadow = true; group.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(.25, 20, 14), skin); head.position.y = 1.63; head.castShadow = true; group.add(head);
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(.257, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), hair); hairCap.position.y = 1.72; hairCap.castShadow = true; group.add(hairCap);
  const eyesMat = new THREE.MeshStandardMaterial({ color: "#443730", roughness: 1 });
  for (const eyeX of [-.085, .085]) { const eye = new THREE.Mesh(new THREE.SphereGeometry(.023, 8, 8), eyesMat); eye.position.set(eyeX, 1.64, .225); group.add(eye); }
  const arms: THREE.Object3D[] = [], legs: THREE.Object3D[] = [];
  for (const sign of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(.085, .35, 3, 7), shirt); arm.position.set(sign * .34, 1.02, 0); arm.rotation.z = sign * -.12; arm.castShadow = true; group.add(arm); arms.push(arm);
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(.095, .32, 3, 7), pants); leg.position.set(sign * .14, .43, 0); leg.castShadow = true; group.add(leg); legs.push(leg);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(.18, .1, .28), white); shoe.position.set(sign * .14, .12, .04); shoe.castShadow = true; group.add(shoe);
  }
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(.48, 20), new THREE.MeshBasicMaterial({ color: "#4c6254", transparent: true, opacity: .16, depthWrite: false })); shadow.rotation.x = -Math.PI / 2; shadow.position.y = .025; group.add(shadow);
  const badge = makeNameSprite(agent.name);
  badge.position.set(0, 2.18, 0); badge.scale.set(1.55, .43, 1); group.add(badge);
  const state = String(agent.state || "IDLE");
  return { group, id: agent.id, zoneCode: departmentForAgent(agent), shirt, phase: index * 1.17, moving: false, path: [], pathIndex: 0, speed: 1.75 + (index % 4) * .12, limbs: [...arms, ...legs], state };
}
function makeNameSprite(name: string) {
  const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 72;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "rgba(255,255,255,.96)"; context.beginPath(); context.roundRect(8, 10, 240, 54, 15); context.fill();
  context.strokeStyle = "#b8ccbe"; context.lineWidth = 3; context.stroke();
  context.fillStyle = "#314d3b"; context.font = "bold 27px Inter, Arial, sans-serif"; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(name.slice(0, 18), 128, 38);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  return sprite;
}

function buildWalls(scene: THREE.Scene) {
  const glass = new THREE.MeshStandardMaterial({ color: "#c6e3de", roughness: .22, metalness: .08, transparent: true, opacity: .48 });
  const frame = new THREE.MeshStandardMaterial({ color: "#d9e5de", roughness: .38, metalness: .15 });
  const roomW = 10, roomD = 7, centerXs = [-18, -6, 6, 18], centerZs = [-10, 0, 10], wallH = 1.42, wallT = .12;
  const addWall = (x: number, z: number, sx: number, sz: number) => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(sx, wallH, sz), glass); wall.position.set(x, wallH / 2, z); wall.castShadow = true; wall.receiveShadow = true; scene.add(wall);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(sx + .04, .09, sz + .04), frame); rail.position.set(x, wallH, z); rail.castShadow = true; scene.add(rail);
  };
  // Outer perimeter with a generous main entrance.
  addWall(0, -13.5, 48, wallT);
  addWall(-24, 0, wallT, 27);
  addWall(24, 0, wallT, 27);
  addWall(-12, 13.5, 24, wallT); addWall(12, 13.5, 24, wallT);
  // Glass partition between columns. Gaps are doorways aligned to the desk-side aisle.
  for (const boundaryX of [-12, 0, 12]) {
    for (const centerZ of centerZs) {
      const doorZ = centerZ + 1.45, halfRoom = roomD / 2, halfDoor = 1.05;
      const leftLength = doorZ - halfDoor - (centerZ - halfRoom);
      const rightLength = (centerZ + halfRoom) - (doorZ + halfDoor);
      if (leftLength > .1) addWall(boundaryX, centerZ - halfRoom + leftLength / 2, wallT, leftLength);
      if (rightLength > .1) addWall(boundaryX, doorZ + halfDoor + rightLength / 2, wallT, rightLength);
    }
  }
  // Horizontal room boundaries leave a centered doorway into the cross-corridor.
  for (const boundaryZ of [-5, 5]) {
    for (const centerX of centerXs) {
      const halfRoom = roomW / 2, halfDoor = 1.2;
      const leftLength = halfRoom - halfDoor, rightLength = halfRoom - halfDoor;
      if (leftLength > .1) addWall(centerX - halfRoom + leftLength / 2, boundaryZ, leftLength, wallT);
      if (rightLength > .1) addWall(centerX + halfDoor + rightLength / 2, boundaryZ, rightLength, wallT);
    }
  }
}
function routeBetween(start: THREE.Vector3, fromCode: string, target: THREE.Vector3, toCode: string) {
  const from = zoneFor(fromCode), to = zoneFor(toCode);
  const path: THREE.Vector3[] = [];
  void start;
  const add = (x: number, z: number) => path.push(new THREE.Vector3(x, 0, z));
  // First use door-aligned aisle in the source zone.
  if (from.code !== to.code) {
    const cellX = from.x, cellZ = from.z;
    add(cellX, cellZ + 1.45);
    let col = ZONES.findIndex(item => item.code === from.code) % 4;
    let row = Math.floor(ZONES.findIndex(item => item.code === from.code) / 4);
    const targetIndex = ZONES.findIndex(item => item.code === to.code);
    const targetCol = targetIndex % 4, targetRow = Math.floor(targetIndex / 4);
    while (col !== targetCol) {
      const nextCol = col + (targetCol > col ? 1 : -1);
      const centerColumns = [-18, -6, 6, 18];
      const boundaryX = (centerColumns[col]! + centerColumns[nextCol]!) / 2;
      add(boundaryX, [-10, 0, 10][row] + 1.45);
      col = nextCol;
    }
    while (row !== targetRow) {
      const nextRow = row + (targetRow > row ? 1 : -1);
      const centerRows = [-10, 0, 10];
      const boundaryZ = (centerRows[row]! + centerRows[nextRow]!) / 2;
      add(to.x, boundaryZ);
      row = nextRow;
    }
    add(to.x, to.z + 1.45);
  }
  add(target.x, target.z + 1.2);
  return path;
}

export default function OfficeScene({ agents, onSelectAgent }: { agents: Agent[]; onSelectAgent: (agent: Agent) => void }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const actorsRef = useRef<Map<string, Actor>>(new Map());
  const agentsRef = useRef(agents);
  const selectRef = useRef(onSelectAgent);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const pointerRef = useRef(new THREE.Vector2());
  useEffect(() => { agentsRef.current = agents; }, [agents]);
  useEffect(() => { selectRef.current = onSelectAgent; }, [onSelectAgent]);

  useEffect(() => {
    const mount = mountRef.current; if (!mount) return;
    const scene = new THREE.Scene(); scene.background = new THREE.Color("#e7eeea"); scene.fog = new THREE.Fog("#e7eeea", 54, 105); sceneRef.current = scene;
    const camera = new THREE.PerspectiveCamera(36, mount.clientWidth / mount.clientHeight, .1, 160); camera.position.set(32, 35, 43); camera.lookAt(0, 0, 0);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75)); renderer.setSize(mount.clientWidth, mount.clientHeight); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.16; mount.appendChild(renderer.domElement); rendererRef.current = renderer;
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = .07; controls.minPolarAngle = .45; controls.maxPolarAngle = Math.PI / 2.18; controls.minDistance = 25; controls.maxDistance = 74; controls.target.set(0, 0, 0);  controls.update();
    scene.add(new THREE.HemisphereLight("#f7fffa", "#7d8a77", 2.2));
    const key = new THREE.DirectionalLight("#fff3dc", 3.1); key.position.set(-18, 35, 22); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.camera.left = -35; key.shadow.camera.right = 35; key.shadow.camera.top = 35; key.shadow.camera.bottom = -35; key.shadow.bias = -.0004; scene.add(key);
    const fill = new THREE.DirectionalLight("#d2e6ff", .8); fill.position.set(22, 18, -18); scene.add(fill);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(52, 32), new THREE.MeshStandardMaterial({ map: makeFloorTexture(), roughness: .88 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -.08; floor.receiveShadow = true; scene.add(floor);
    const base = new THREE.Mesh(new THREE.BoxGeometry(52.8, .36, 32.8), new THREE.MeshStandardMaterial({ color: "#a9b9ac", roughness: .88 })); base.position.y = -.28; base.receiveShadow = true; scene.add(base);
    // Corridors are visibly wider than the office partitions and stay unobstructed.
    for (const z of [-5, 5]) {
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(51, 2.7), new THREE.MeshStandardMaterial({ color: "#d7e4dc", roughness: .95 })); strip.rotation.x = -Math.PI / 2; strip.position.set(0, .025, z); strip.receiveShadow = true; scene.add(strip);
      const edge = new THREE.MeshStandardMaterial({ color: "#bccdc2", roughness: .9 });
      for (const dz of [-1.32, 1.32]) { const line = new THREE.Mesh(new THREE.BoxGeometry(51, .035, .055), edge); line.position.set(0, .07, z + dz); scene.add(line); }
    }
    for (const x of [-12, 0, 12]) {
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 30), new THREE.MeshStandardMaterial({ color: "#d7e4dc", roughness: .95 })); strip.rotation.x = -Math.PI / 2; strip.position.set(x, .026, 0); strip.receiveShadow = true; scene.add(strip);
    }
    for (const zone of ZONES) {
      const floorPanel = new THREE.Mesh(new THREE.PlaneGeometry(10, 7), new THREE.MeshStandardMaterial({ color: zone.color, roughness: .95 })); floorPanel.rotation.x = -Math.PI / 2; floorPanel.position.set(zone.x, .018, zone.z); floorPanel.receiveShadow = true; scene.add(floorPanel);
      createOfficeFurniture(scene, zone);
      const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 96; const context = canvas.getContext("2d")!;
      context.fillStyle = "rgba(255,255,255,.92)"; context.fillRect(0, 0, 512, 96); context.strokeStyle = "#c6d6ca"; context.lineWidth = 5; context.strokeRect(3, 3, 506, 90);
      context.fillStyle = "#3c5d47"; context.font = "bold 34px Inter, Arial, sans-serif"; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(zone.label, 256, 49);
      const title = new THREE.Mesh(new THREE.PlaneGeometry(4.1, .78), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, side: THREE.DoubleSide })); title.position.set(zone.x, 2.7, zone.z - 3.45); title.rotation.x = -.08; scene.add(title);
    }
    buildWalls(scene);
    // Broad entry lobby at the front of the world.
    makeBox(scene, -1.6, .08, 16.1, 5.7, .16, 1.0, "#e3e9df");
    const welcomeCanvas = document.createElement("canvas"); welcomeCanvas.width = 600; welcomeCanvas.height = 100; const ctx = welcomeCanvas.getContext("2d")!; ctx.fillStyle = "#385a43"; ctx.font = "bold 40px Inter, Arial, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("KANTORAI  ·  OPEN WORKSPACE", 300, 52);
    const welcome = new THREE.Mesh(new THREE.PlaneGeometry(7, 1.12), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(welcomeCanvas), transparent: true, side: THREE.DoubleSide })); welcome.position.set(0, 3.1, 16); scene.add(welcome);
    const actors = actorsRef.current;
    for (const agent of agentsRef.current) {
      if (actors.has(agent.id)) continue;
      const actor = createCharacter(agent, actors.size); const zone = zoneFor(departmentForAgent(agent)); actor.zoneCode = zone.code; actor.group.position.set(zone.x + (Math.random() - .5) * 1.2, 0, zone.z + 1.55 + (Math.random() - .5) * .55); actor.group.userData.agentId = agent.id; scene.add(actor.group); actors.set(agent.id, actor);
    }
    const resize = () => { if (!mount.isConnected) return; camera.aspect = mount.clientWidth / Math.max(1, mount.clientHeight); camera.updateProjectionMatrix(); renderer.setSize(mount.clientWidth, mount.clientHeight); };
    const onPointer = (event: PointerEvent) => { const rect = renderer.domElement.getBoundingClientRect(); pointerRef.current.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1); raycasterRef.current.setFromCamera(pointerRef.current, camera); const hits = raycasterRef.current.intersectObjects([...actors.values()].map(actor => actor.group), true); const object = hits[0]?.object; if (!object) return; let parent: THREE.Object3D | null = object; while (parent && !parent.userData.agentId) parent = parent.parent; const id = parent?.userData.agentId as string | undefined; const agent = agentsRef.current.find(item => item.id === id); if (agent) selectRef.current(agent); };
    renderer.domElement.addEventListener("pointerdown", onPointer); window.addEventListener("resize", resize);
    let frame = 0; const clock = new THREE.Clock(); let idleTime = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate); const delta = Math.min(clock.getDelta(), .05); const elapsed = clock.elapsedTime; idleTime += delta;
      for (const actor of actors.values()) {
        const currentAgent = agentsRef.current.find(item => item.id === actor.id); if (!currentAgent) continue;
        actor.state = currentAgent.state;
        if (!actor.moving && actor.state === "IDLE" && idleTime > 1.5 + Math.random() * 2.4 && Math.random() < .012) {
          const travelToAnotherRoom = Math.random() < .42;
          const zone = travelToAnotherRoom ? ZONES[Math.floor(Math.random() * ZONES.length)]! : zoneFor(actor.zoneCode);
          const targetX = zone.x + (Math.random() - .5) * 2.4;
          const targetZ = zone.z + 1.35 + (Math.random() - .5) * .7;
          actor.targetZoneCode = zone.code;
          actor.path = routeBetween(actor.group.position, actor.zoneCode, new THREE.Vector3(targetX, 0, targetZ), zone.code);
          actor.pathIndex = 0; actor.moving = actor.path.length > 0; idleTime = 0;
        }
        if (actor.moving && actor.pathIndex < actor.path.length) {
          const target = actor.path[actor.pathIndex]!; const dx = target.x - actor.group.position.x; const dz = target.z - actor.group.position.z; const dist = Math.hypot(dx, dz);
          if (dist < .13) {
            actor.pathIndex++;
            if (actor.pathIndex >= actor.path.length) { actor.moving = false; if (actor.targetZoneCode) actor.zoneCode = actor.targetZoneCode; actor.targetZoneCode = undefined; }
          } else { const step = Math.min(dist, actor.speed * delta); actor.group.position.x += dx / dist * step; actor.group.position.z += dz / dist * step; actor.group.rotation.y = Math.atan2(dx, dz); }
        }
        const walk = actor.moving; actor.group.position.y = walk ? Math.abs(Math.sin(elapsed * 7 + actor.phase)) * .045 : Math.sin(elapsed * 1.5 + actor.phase) * .018;
        actor.limbs.forEach((limb, index) => { const opposite = index % 2 ? -1 : 1; if (walk) { limb.rotation.x = Math.sin(elapsed * 8 + actor.phase + index * Math.PI) * .42 * opposite; if (index < 2) limb.rotation.z = opposite * .1; } else { limb.rotation.x *= .84; limb.rotation.z *= .84; } });
      }
      controls.update(); renderer.render(scene, camera);
    };
    animate();
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", resize); renderer.domElement.removeEventListener("pointerdown", onPointer); controls.dispose(); renderer.dispose(); mount.removeChild(renderer.domElement); scene.clear(); actorsRef.current.clear(); sceneRef.current = null; rendererRef.current = null; };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current; if (!scene) return;
    const actors = actorsRef.current;
    for (const actor of actors.values()) {
      const current = agents.find(agent => agent.id === actor.id);
      if (!current) { scene.remove(actor.group); actors.delete(actor.id); }
    }
    agents.forEach((agent, index) => {
      let actor = actors.get(agent.id);
      if (!actor) {
        actor = createCharacter(agent, index); const zone = zoneFor(departmentForAgent(agent)); actor.zoneCode = zone.code; actor.group.position.set(zone.x + (Math.random() - .5) * 1.2, 0, zone.z + 1.55); actor.group.userData.agentId = agent.id; scene.add(actor.group); actors.set(agent.id, actor);
      } else {
        actor.zoneCode = departmentForAgent(agent);
        actor.group.children.filter(child => child instanceof THREE.Sprite).forEach(child => actor!.group.remove(child));
        const badge = makeNameSprite(agent.name); badge.position.set(0, 2.18, 0); badge.scale.set(1.55, .43, 1); actor.group.add(badge);
      }
    });
  }, [agents]);

  return <div className="scene-shell"><div className="scene-note"><span><i /> KANTORAI · 3D WORKSPACE</span><span>Drag untuk memutar · Scroll untuk zoom</span></div><div className="scene-canvas" ref={mountRef} /><div className="scene-footer"><span>12 zona kantor</span><span>{agents.length} AI employee</span><span>3D preview · interaksi lokal</span></div></div>;
}
