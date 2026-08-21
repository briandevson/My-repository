import * as THREE from 'three';

/**
 * Every model in the game is generated from primitives at runtime - there are no
 * external art assets. Each factory returns a THREE.Group whose `userData` holds
 * the parts an animator needs (limbs, flames, and so on).
 */

const materialCache = new Map();

export function flatMaterial(colour, options = {}) {
  const key = `${colour}-${options.transparent ? 1 : 0}-${options.opacity ?? 1}-${options.emissive ?? 0}`;
  if (materialCache.has(key)) return materialCache.get(key);
  const material = new THREE.MeshLambertMaterial({
    color: colour,
    emissive: options.emissive ?? 0x000000,
    transparent: !!options.transparent,
    opacity: options.opacity ?? 1,
    flatShading: true,
  });
  materialCache.set(key, material);
  return material;
}

function box(width, height, depth, colour, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), flatMaterial(colour));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

const EQUIP_COLOURS = {
  bronze: 0xa9743a,
  iron: 0x6e6e73,
  steel: 0xb8bcc4,
  mithril: 0x4a5fb0,
  adamantite: 0x3f7a5a,
  leather: 0x7a5230,
  wizard: 0x2f2f6b,
};

function metalOf(itemId) {
  if (!itemId) return null;
  for (const [tier, colour] of Object.entries(EQUIP_COLOURS)) {
    if (itemId.startsWith(tier)) return colour;
  }
  if (itemId.includes('bow')) return 0x8a6a3a;
  if (itemId.includes('staff')) return 0x5a3a7a;
  return null;
}

/**
 * A blocky humanoid: head, torso, two arms, two legs. Equipment is expressed as
 * recolours and small attachments rather than separate meshes per item.
 */
export function createHumanoid(appearance = {}, equipment = {}) {
  const group = new THREE.Group();
  const skin = appearance.skin ?? 0xc98f5a;
  const shirt = metalOf(equipment.body) ?? appearance.shirt ?? 0x3a5fb0;
  const legsColour = metalOf(equipment.legs) ?? appearance.legs ?? 0x40404a;

  const torso = box(0.42, 0.46, 0.26, shirt, 0, 0.86, 0);
  const head = box(0.3, 0.3, 0.3, skin, 0, 1.24, 0);
  if (equipment.head) {
    const helm = box(0.34, 0.16, 0.34, metalOf(equipment.head) ?? 0x8a8a8a, 0, 1.34, 0);
    group.add(helm);
  }
  const leftArm = box(0.13, 0.42, 0.16, shirt, -0.28, 0.86, 0);
  const rightArm = box(0.13, 0.42, 0.16, shirt, 0.28, 0.86, 0);
  const leftLeg = box(0.16, 0.44, 0.18, legsColour, -0.11, 0.4, 0);
  const rightLeg = box(0.16, 0.44, 0.18, legsColour, 0.11, 0.4, 0);

  group.add(torso, head, leftArm, rightArm, leftLeg, rightLeg);

  let weapon = null;
  if (equipment.weapon) {
    const colour = metalOf(equipment.weapon) ?? 0x9a9a9a;
    if (equipment.weapon.includes('bow')) {
      weapon = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.03, 6, 10, Math.PI * 1.2), flatMaterial(colour));
      weapon.position.set(0.34, 0.9, 0.1);
      weapon.rotation.y = Math.PI / 2;
    } else if (equipment.weapon.includes('staff')) {
      weapon = box(0.06, 1.1, 0.06, colour, 0.34, 0.86, 0.08);
    } else {
      weapon = box(0.08, 0.62, 0.1, colour, 0.34, 0.92, 0.14);
      weapon.add(box(0.22, 0.06, 0.12, 0x5a3a1a, 0, -0.3, 0));
    }
    group.add(weapon);
  }
  let shield = null;
  if (equipment.shield) {
    shield = box(0.1, 0.4, 0.32, metalOf(equipment.shield) ?? 0x8a8a8a, -0.32, 0.88, 0);
    group.add(shield);
  }
  if (equipment.cape) {
    group.add(box(0.36, 0.5, 0.06, 0x7a2f4a, 0, 0.86, -0.18));
  }

  group.userData.parts = { torso, head, leftArm, rightArm, leftLeg, rightLeg, weapon, shield };
  return group;
}

/** Four-legged animals: rats, cows. */
export function createBeast(colour = 0x8a7a5a) {
  const group = new THREE.Group();
  const body = box(0.46, 0.34, 0.78, colour, 0, 0.48, 0);
  const head = box(0.3, 0.28, 0.3, colour, 0, 0.56, 0.5);
  const legs = [];
  for (const [x, z] of [[-0.16, 0.28], [0.16, 0.28], [-0.16, -0.28], [0.16, -0.28]]) {
    const leg = box(0.11, 0.32, 0.11, colour, x, 0.16, z);
    legs.push(leg);
    group.add(leg);
  }
  const tail = box(0.06, 0.06, 0.36, colour, 0, 0.56, -0.5);
  group.add(body, head, tail);
  group.userData.parts = { leftLeg: legs[0], rightLeg: legs[1], leftArm: legs[2], rightArm: legs[3], head };
  return group;
}

export function createDragon(colour = 0x3d6b3a) {
  const group = new THREE.Group();
  const body = box(0.9, 0.7, 1.6, colour, 0, 1.1, 0);
  const neck = box(0.4, 0.4, 0.7, colour, 0, 1.5, 0.9);
  const head = box(0.5, 0.42, 0.6, colour, 0, 1.7, 1.4);
  const jaw = box(0.4, 0.14, 0.5, 0x8a3a2a, 0, 1.54, 1.5);
  const tail = box(0.3, 0.3, 1.2, colour, 0, 1.0, -1.2);
  const wingL = box(0.08, 0.6, 1.2, 0x2a4a2a, -0.6, 1.5, -0.1);
  const wingR = box(0.08, 0.6, 1.2, 0x2a4a2a, 0.6, 1.5, -0.1);
  wingL.rotation.z = 0.5;
  wingR.rotation.z = -0.5;
  const legs = [];
  for (const [x, z] of [[-0.35, 0.5], [0.35, 0.5], [-0.35, -0.5], [0.35, -0.5]]) {
    const leg = box(0.22, 0.7, 0.22, colour, x, 0.35, z);
    legs.push(leg);
    group.add(leg);
  }
  group.add(body, neck, head, jaw, tail, wingL, wingR);
  group.userData.parts = { leftLeg: legs[0], rightLeg: legs[1], leftArm: wingL, rightArm: wingR, head };
  return group;
}

// ---------------------------------------------------------------------------
// Scenery
// ---------------------------------------------------------------------------

export function createTree(colour = 0x3f7a34, kind = 'tree') {
  const group = new THREE.Group();
  const trunkHeight = kind === 'maple_tree' ? 2.4 : kind === 'oak_tree' ? 2.0 : 1.7;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, trunkHeight, 6), flatMaterial(0x6b4a2a));
  trunk.position.y = trunkHeight / 2;
  group.add(trunk);

  if (kind === 'willow_tree') {
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(1.15, 7, 5), flatMaterial(colour));
    canopy.position.y = trunkHeight + 0.5;
    canopy.scale.set(1, 0.75, 1);
    group.add(canopy);
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      const frond = box(0.08, 1.0, 0.08, colour, Math.cos(angle) * 0.85, trunkHeight + 0.05, Math.sin(angle) * 0.85);
      group.add(frond);
    }
  } else {
    const tiers = kind === 'maple_tree' ? 3 : 2;
    for (let i = 0; i < tiers; i++) {
      const radius = 1.25 - i * 0.3;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(radius, 1.3, 7), flatMaterial(colour));
      cone.position.y = trunkHeight + 0.25 + i * 0.6;
      group.add(cone);
    }
  }
  return group;
}

export function createStump() {
  const group = new THREE.Group();
  const stump = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.35, 7), flatMaterial(0x6b4a2a));
  stump.position.y = 0.18;
  group.add(stump);
  return group;
}

export function createRock(colour = 0x8a8a8a, ore = true) {
  const group = new THREE.Group();
  const base = new THREE.Mesh(new THREE.DodecahedronGeometry(0.6, 0), flatMaterial(0x77747a));
  base.position.y = 0.4;
  base.rotation.set(0.4, 0.8, 0.2);
  base.scale.set(1, 0.8, 1);
  group.add(base);
  if (ore) {
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2 + 0.5;
      const vein = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 0), flatMaterial(colour));
      vein.position.set(Math.cos(angle) * 0.34, 0.5 + (i % 2) * 0.18, Math.sin(angle) * 0.34);
      group.add(vein);
    }
  }
  return group;
}

export function createFire() {
  const group = new THREE.Group();
  const logs = box(0.7, 0.14, 0.2, 0x5a3a1a, 0, 0.07, 0);
  logs.rotation.y = 0.4;
  const logs2 = box(0.7, 0.14, 0.2, 0x4a2f14, 0, 0.07, 0);
  logs2.rotation.y = -0.6;
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.8, 6), flatMaterial(0xff8a2a, { emissive: 0x883000 }));
  flame.position.y = 0.55;
  const inner = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 5), flatMaterial(0xffe08a, { emissive: 0xaa7700 }));
  inner.position.y = 0.5;
  group.add(logs, logs2, flame, inner);
  group.userData.flame = flame;
  group.userData.light = new THREE.PointLight(0xff9040, 1.4, 7);
  group.userData.light.position.y = 0.8;
  group.add(group.userData.light);
  return group;
}

export function createFurnace() {
  const group = new THREE.Group();
  group.add(box(1.5, 1.6, 1.5, 0x6b6259, 0, 0.8, 0));
  group.add(box(1.7, 0.24, 1.7, 0x554e46, 0, 1.7, 0));
  const mouth = box(0.7, 0.7, 0.2, 0xff7a2a, 0, 0.6, 0.7);
  mouth.material = flatMaterial(0xff7a2a, { emissive: 0x883000 });
  group.add(mouth);
  const chimney = box(0.5, 0.9, 0.5, 0x554e46, 0, 2.2, -0.3);
  group.add(chimney);
  return group;
}

export function createAnvil() {
  const group = new THREE.Group();
  group.add(box(0.5, 0.28, 0.34, 0x3a3a42, 0, 0.14, 0));
  group.add(box(0.22, 0.3, 0.22, 0x3a3a42, 0, 0.42, 0));
  group.add(box(0.9, 0.26, 0.4, 0x4a4a52, 0, 0.68, 0));
  return group;
}

export function createBankBooth() {
  const group = new THREE.Group();
  group.add(box(1.0, 1.05, 0.5, 0x8a6a3a, 0, 0.52, 0));
  group.add(box(1.1, 0.12, 0.7, 0x6b4a2a, 0, 1.1, 0));
  return group;
}

export function createRange() {
  const group = new THREE.Group();
  group.add(box(1.1, 0.9, 0.9, 0x6b6259, 0, 0.45, 0));
  const fire = box(0.6, 0.4, 0.16, 0xff7a2a, 0, 0.4, 0.46);
  fire.material = flatMaterial(0xff7a2a, { emissive: 0x883000 });
  group.add(fire);
  group.add(box(1.2, 0.1, 1.0, 0x4a4a52, 0, 0.94, 0));
  return group;
}

export function createAltar() {
  const group = new THREE.Group();
  group.add(box(1.4, 0.3, 0.8, 0xe0dcc8, 0, 0.15, 0));
  group.add(box(1.0, 0.6, 0.6, 0xd0ccb8, 0, 0.5, 0));
  group.add(box(1.6, 0.2, 0.9, 0xf0ecd8, 0, 0.9, 0));
  const candleL = box(0.1, 0.3, 0.1, 0xfff0c0, -0.6, 1.15, 0);
  const candleR = box(0.1, 0.3, 0.1, 0xfff0c0, 0.6, 1.15, 0);
  group.add(candleL, candleR);
  return group;
}

export function createStall() {
  const group = new THREE.Group();
  group.add(box(1.4, 0.1, 1.0, 0x8a6a3a, 0, 0.9, 0));
  for (const x of [-0.6, 0.6]) {
    group.add(box(0.1, 0.9, 0.1, 0x6b4a2a, x, 0.45, -0.4));
    group.add(box(0.1, 0.9, 0.1, 0x6b4a2a, x, 0.45, 0.4));
  }
  const canopy = box(1.6, 0.12, 1.2, 0xb04a7a, 0, 1.3, 0);
  group.add(canopy);
  group.add(box(1.2, 0.3, 0.7, 0xe0d0e8, 0, 1.05, 0));
  return group;
}

export function createWall(colour = 0xa89f8c, door = false) {
  const group = new THREE.Group();
  if (door) {
    group.add(box(1.02, 0.3, 0.28, colour, 0, 1.85, 0));
    group.add(box(0.9, 1.7, 0.16, 0x6b4a2a, 0, 0.85, 0));
  } else {
    group.add(box(1.02, 2.0, 0.34, colour, 0, 1.0, 0));
  }
  return group;
}

export function createFence() {
  const group = new THREE.Group();
  group.add(box(0.12, 0.9, 0.12, 0x8a6a4a, -0.4, 0.45, 0));
  group.add(box(0.12, 0.9, 0.12, 0x8a6a4a, 0.4, 0.45, 0));
  group.add(box(1.0, 0.1, 0.06, 0x8a6a4a, 0, 0.75, 0));
  group.add(box(1.0, 0.1, 0.06, 0x8a6a4a, 0, 0.45, 0));
  return group;
}

export function createBush(colour = 0x2f6b2a) {
  const group = new THREE.Group();
  const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 0), flatMaterial(colour));
  bush.position.y = 0.4;
  bush.scale.set(1.2, 0.9, 1.2);
  group.add(bush);
  return group;
}

export function createLogPile() {
  const group = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.9, 6), flatMaterial(0x7a5a2a));
    log.rotation.z = Math.PI / 2;
    log.position.set(0, 0.15 + i * 0.26, (i % 2) * 0.2 - 0.1);
    group.add(log);
  }
  return group;
}

export function createObstacle(type, colour) {
  const group = new THREE.Group();
  if (type === 'log_balance') {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 3.4, 7), flatMaterial(colour));
    log.rotation.x = Math.PI / 2;
    log.position.y = 0.3;
    group.add(log);
  } else if (type === 'rope_swing') {
    group.add(box(0.14, 2.6, 0.14, 0x6b4a2a, 0, 1.3, 0));
    const rope = box(0.06, 1.4, 0.06, colour, 0.6, 1.7, 0);
    rope.rotation.z = 0.3;
    group.add(rope);
  } else {
    group.add(box(1.0, 2.6, 0.4, colour, 0, 1.3, 0));
    for (let i = 0; i < 3; i++) group.add(box(0.7, 0.1, 0.5, 0x6b4a2a, 0, 0.5 + i * 0.7, 0.1));
  }
  return group;
}

/** Small spinning marker for an item lying on the ground. */
export function createGroundItem(colour = 0xd4af37) {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.2, 0), flatMaterial(colour, { emissive: 0x222200 }));
  mesh.position.y = 0.28;
  group.add(mesh);
  group.userData.spin = mesh;
  return group;
}

/**
 * Build the mesh for a world object type. `colour` comes from the object
 * definition so new content shows up without touching this file.
 */
export function createObjectMesh(type, def) {
  const colour = def?.colour ?? 0x999999;
  switch (def?.kind) {
    case 'tree':
      return createTree(colour, type);
    case 'stump':
      return createStump();
    case 'rock':
      return createRock(colour, type !== 'depleted_rock' && type !== 'rock_scenery');
    case 'fire':
      return createFire();
    case 'furnace':
      return createFurnace();
    case 'anvil':
      return createAnvil();
    case 'bank':
      return createBankBooth();
    case 'range':
      return createRange();
    case 'altar':
      return createAltar();
    case 'stall':
      return createStall();
    case 'wall':
      return type === 'fence' ? createFence() : createWall(colour, false);
    case 'door':
      return createWall(0xa89f8c, true);
    case 'agility':
      return createObstacle(type, colour);
    case 'scenery':
      if (type === 'bush') return createBush(colour);
      if (type === 'log_pile') return createLogPile();
      return createRock(colour, false);
    case 'fishing': {
      const group = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.06, 6, 12), flatMaterial(colour));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.05;
      group.add(ring);
      group.userData.bob = ring;
      return group;
    }
    default:
      return createBush(colour);
  }
}
