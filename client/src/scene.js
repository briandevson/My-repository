import * as THREE from 'three';
import { TILE_TYPES, WATER_LEVEL } from '../../shared/constants.js';
import { heightAt } from '../../shared/worldgen.js';
import { OBJECTS } from '../../shared/objects.js';
import { NPCS } from '../../shared/npcs.js';
import { getItem } from '../../shared/items.js';
import {
  createBeast,
  createDragon,
  createGroundItem,
  createHumanoid,
  createObjectMesh,
  flatMaterial,
} from './models.js';

const TILE_COLOURS = {
  [TILE_TYPES.GRASS]: [0x4a7c3f, 0x548a45],
  [TILE_TYPES.DIRT]: [0x7a6242, 0x846a48],
  [TILE_TYPES.PATH]: [0x9a8a6a, 0xa89878],
  [TILE_TYPES.WATER]: [0x1f4f7a, 0x246090],
  [TILE_TYPES.SAND]: [0xcbb98a, 0xd6c497],
  [TILE_TYPES.STONE]: [0x7d7d84, 0x8a8a92],
  [TILE_TYPES.FLOOR]: [0x8a7250, 0x957c58],
};

/** Objects are only meshed within this many tiles of the player. */
const OBJECT_STREAM_RADIUS = 34;

export class GameScene {
  constructor(canvas, world) {
    this.world = world;
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8fc0e8);
    this.scene.fog = new THREE.Fog(0x8fc0e8, 46, 88);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
    this.cameraYaw = Math.PI;
    this.cameraPitch = 1.0;
    this.cameraDistance = 17;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.88));
    const sun = new THREE.DirectionalLight(0xfff2d0, 0.95);
    sun.position.set(30, 60, 20);
    this.scene.add(sun);

    this.terrainGroup = new THREE.Group();
    this.objectGroup = new THREE.Group();
    this.entityGroup = new THREE.Group();
    this.groundGroup = new THREE.Group();
    this.overlayGroup = new THREE.Group();
    this.scene.add(this.terrainGroup, this.objectGroup, this.entityGroup, this.groundGroup, this.overlayGroup);

    /** index -> { mesh, type } for streamed scenery. */
    this.objectMeshes = new Map();
    /** Server-sent object state that differs from the generated world. */
    this.objectOverrides = new Map();
    /** entity id -> { mesh, data, current, target, label } */
    this.entities = new Map();
    this.groundMeshes = new Map();
    this.splats = [];

    this.selfId = null;
    this.selfPosition = new THREE.Vector3(80, 0, 96);
    this.time = 0;

    this.raycaster = new THREE.Raycaster();
    this.buildTerrain();
    this.buildWater();
    this.buildMarker();
    this.resize();
  }

  // --- Static world --------------------------------------------------------

  buildTerrain() {
    const { size, tiles } = this.world;
    const positions = [];
    const colours = [];
    const colour = new THREE.Color();

    const h = (x, y) => this.world.heights[Math.min(size - 1, y) * size + Math.min(size - 1, x)];

    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const tile = tiles[y * size + x];
        const [base, alt] = TILE_COLOURS[tile] ?? TILE_COLOURS[TILE_TYPES.GRASS];
        // A cheap checker of two shades gives the ground texture without a texture.
        colour.setHex((x + y) % 2 === 0 ? base : alt);

        const h00 = h(x, y);
        const h10 = h(x + 1, y);
        const h01 = h(x, y + 1);
        const h11 = h(x + 1, y + 1);

        // Counter-clockwise when seen from above, so the ground faces the camera.
        positions.push(x, h00, y, x, h01, y + 1, x + 1, h10, y);
        positions.push(x + 1, h10, y, x, h01, y + 1, x + 1, h11, y + 1);
        for (let i = 0; i < 6; i++) colours.push(colour.r, colour.g, colour.b);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    geometry.computeVertexNormals();

    this.terrain = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    );
    this.terrain.userData.kind = 'terrain';
    this.terrainGroup.add(this.terrain);
  }

  buildWater() {
    const { size } = this.world;
    const geometry = new THREE.PlaneGeometry(size, size, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    const water = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({ color: 0x2f7fc0, transparent: true, opacity: 0.72 }),
    );
    water.position.set(size / 2, WATER_LEVEL, size / 2);
    water.userData.kind = 'water';
    this.water = water;
    this.terrainGroup.add(water);
  }

  buildMarker() {
    const geometry = new THREE.RingGeometry(0.28, 0.42, 16);
    geometry.rotateX(-Math.PI / 2);
    this.marker = new THREE.Mesh(geometry, flatMaterial(0xffe066, { transparent: true, opacity: 0.9 }));
    this.marker.visible = false;
    this.overlayGroup.add(this.marker);
  }

  showMarker(x, y) {
    this.marker.position.set(x, heightAt(this.world, x, y) + 0.06, y);
    this.marker.visible = true;
    this.markerTimer = 0.8;
  }

  // --- Object streaming ----------------------------------------------------

  /** Type of an object index right now, honouring server overrides. */
  objectTypeAt(index) {
    const override = this.objectOverrides.get(index);
    if (override) return override.type;
    return this.world.objects[index]?.type ?? null;
  }

  setOverrides(list, centreX, centreY, radius) {
    const seen = new Set();
    for (const entry of list) {
      seen.add(entry.index);
      const previous = this.objectOverrides.get(entry.index);
      if (previous?.type === entry.type) continue;
      this.objectOverrides.set(entry.index, entry);
      this.removeObjectMesh(entry.index);
    }
    // Anything previously overridden, in view, and absent from this snapshot has
    // reverted on the server (a rock respawned, a fire burnt out).
    for (const [index, entry] of this.objectOverrides) {
      if (seen.has(index)) continue;
      if (Math.max(Math.abs(entry.x - centreX), Math.abs(entry.y - centreY)) > radius) continue;
      this.objectOverrides.delete(index);
      this.removeObjectMesh(index);
    }
  }

  removeObjectMesh(index) {
    const entry = this.objectMeshes.get(index);
    if (!entry) return;
    this.objectGroup.remove(entry.mesh);
    this.objectMeshes.delete(index);
  }

  streamObjects(px, py) {
    const radius = OBJECT_STREAM_RADIUS;
    const wanted = new Set();

    const consider = (index, type, x, y) => {
      if (!type) return;
      if (Math.abs(x - px) > radius || Math.abs(y - py) > radius) return;
      wanted.add(index);
      const existing = this.objectMeshes.get(index);
      if (existing && existing.type === type) return;
      if (existing) this.removeObjectMesh(index);
      const def = OBJECTS[type];
      const mesh = createObjectMesh(type, def);
      mesh.position.set(x, heightAt(this.world, x, y), y);
      mesh.userData.kind = 'object';
      mesh.userData.index = index;
      mesh.userData.type = type;
      this.objectGroup.add(mesh);
      this.objectMeshes.set(index, { mesh, type });
    };

    for (const object of this.world.objects) {
      consider(object.index, this.objectTypeAt(object.index), object.x, object.y);
    }
    for (const [index, entry] of this.objectOverrides) {
      if (index >= 1_000_000) consider(index, entry.type, entry.x, entry.y);
    }
    for (const index of [...this.objectMeshes.keys()]) {
      if (!wanted.has(index)) this.removeObjectMesh(index);
    }
  }

  // --- Entities ------------------------------------------------------------

  buildEntityMesh(data) {
    if (data.kind === 'player') return createHumanoid(data.appearance, data.equipment ?? {});
    const def = NPCS[data.type];
    if (def?.shape === 'beast') return createBeast(def.colour);
    if (def?.shape === 'dragon') return createDragon(def.colour);
    return createHumanoid({ skin: 0xb08050, shirt: def?.colour ?? 0x777777, legs: 0x4a4a4a }, {});
  }

  syncEntities(players, npcs) {
    const seen = new Set();
    for (const data of [...players, ...npcs]) {
      seen.add(data.id);
      let entity = this.entities.get(data.id);
      const equipmentKey = data.kind === 'player' ? Object.values(data.equipment ?? {}).join('|') : '';
      if (entity && entity.equipmentKey !== undefined && entity.equipmentKey !== equipmentKey) {
        this.entityGroup.remove(entity.mesh);
        entity = null;
      }
      if (!entity) {
        const mesh = this.buildEntityMesh(data);
        const scale = NPCS[data.type]?.scale ?? 1;
        mesh.scale.setScalar(scale);
        mesh.userData.kind = 'entity';
        mesh.userData.id = data.id;
        mesh.userData.entityKind = data.kind;
        const label = makeLabel(labelTextFor(data));
        label.position.y = 2.0 * scale;
        mesh.add(label);
        this.entityGroup.add(mesh);
        entity = {
          mesh,
          label,
          labelText: labelTextFor(data),
          equipmentKey,
          current: new THREE.Vector3(data.x, 0, data.y),
          target: new THREE.Vector3(data.x, 0, data.y),
          bubble: null,
          data,
        };
        this.entities.set(data.id, entity);
      }
      const previous = entity.data;
      entity.data = data;
      entity.target.set(data.x, 0, data.y);
      entity.moving = previous.x !== data.x || previous.y !== data.y;
      entity.facing = data.dir;

      const text = labelTextFor(data);
      if (text !== entity.labelText) {
        entity.mesh.remove(entity.label);
        const scale = entity.mesh.scale.x;
        entity.label = makeLabel(text);
        entity.label.position.y = 2.0 * scale;
        entity.mesh.add(entity.label);
        entity.labelText = text;
      }
      if (data.chat && data.chat !== entity.chatText) {
        this.showChatBubble(entity, data.chat);
      } else if (!data.chat && entity.bubble) {
        entity.mesh.remove(entity.bubble);
        entity.bubble = null;
        entity.chatText = null;
      }
      if (data.splat !== null && data.splat !== undefined && data.splat !== entity.lastSplat) {
        this.spawnSplat(entity, data.splat);
      }
      entity.lastSplat = data.splat;
    }

    for (const [id, entity] of this.entities) {
      if (seen.has(id)) continue;
      this.entityGroup.remove(entity.mesh);
      this.entities.delete(id);
    }
  }

  showChatBubble(entity, text) {
    if (entity.bubble) entity.mesh.remove(entity.bubble);
    const bubble = makeLabel(text, { background: 'rgba(255,255,255,0.92)', colour: '#111', size: 22 });
    bubble.position.y = 2.45 * entity.mesh.scale.x;
    entity.mesh.add(bubble);
    entity.bubble = bubble;
    entity.chatText = text;
  }

  spawnSplat(entity, amount) {
    const sprite = makeLabel(String(amount), {
      background: amount > 0 ? 'rgba(190,20,20,0.95)' : 'rgba(40,60,110,0.95)',
      colour: '#fff',
      size: 26,
      padding: 10,
    });
    sprite.position.set(0, 1.4, 0);
    entity.mesh.add(sprite);
    this.splats.push({ sprite, parent: entity.mesh, life: 1.2 });
  }

  syncGroundItems(items) {
    const seen = new Set();
    for (const item of items) {
      seen.add(item.uid);
      if (this.groundMeshes.has(item.uid)) continue;
      const definition = safeItem(item.id);
      const mesh = createGroundItem(colourForItem(item.id));
      mesh.position.set(item.x, heightAt(this.world, item.x, item.y), item.y);
      mesh.userData.kind = 'ground';
      mesh.userData.uid = item.uid;
      mesh.userData.name = definition.name;
      const label = makeLabel(definition.name, { size: 18, background: 'rgba(0,0,0,0.5)' });
      label.position.y = 0.85;
      mesh.add(label);
      this.groundGroup.add(mesh);
      this.groundMeshes.set(item.uid, mesh);
    }
    for (const [uid, mesh] of this.groundMeshes) {
      if (seen.has(uid)) continue;
      this.groundGroup.remove(mesh);
      this.groundMeshes.delete(uid);
    }
  }

  // --- Frame ---------------------------------------------------------------

  update(dt) {
    this.time += dt;

    for (const entity of this.entities.values()) {
      const mesh = entity.mesh;
      // Interpolate toward the tile the server put us on; one tick is 600ms.
      const lerp = Math.min(1, dt * 9);
      entity.current.lerp(entity.target, lerp);
      const groundY = heightAt(this.world, entity.current.x, entity.current.z);
      mesh.position.set(entity.current.x, groundY, entity.current.z);

      const dx = entity.target.x - entity.current.x;
      const dz = entity.target.z - entity.current.z;
      const speed = Math.hypot(dx, dz);
      if (speed > 0.02) mesh.rotation.y = Math.atan2(dx, dz);
      else if (entity.facing !== undefined) mesh.rotation.y = entity.facing;

      animateLimbs(mesh, speed, this.time, entity.data.animation);
      if (entity.data.id === this.selfId) this.selfPosition.copy(mesh.position);
    }

    for (const [, mesh] of this.groundMeshes) {
      if (mesh.userData.spin) mesh.userData.spin.rotation.y += dt * 2;
    }
    for (const [, entry] of this.objectMeshes) {
      const flame = entry.mesh.userData.flame;
      if (flame) {
        flame.scale.setScalar(0.9 + Math.sin(this.time * 9) * 0.12);
        entry.mesh.userData.light.intensity = 1.2 + Math.sin(this.time * 7) * 0.4;
      }
      const bob = entry.mesh.userData.bob;
      if (bob) bob.position.y = 0.05 + Math.sin(this.time * 2 + entry.mesh.position.x) * 0.06;
    }

    for (let i = this.splats.length - 1; i >= 0; i--) {
      const splat = this.splats[i];
      splat.life -= dt;
      splat.sprite.position.y += dt * 0.9;
      splat.sprite.material.opacity = Math.max(0, splat.life);
      if (splat.life <= 0) {
        splat.parent.remove(splat.sprite);
        this.splats.splice(i, 1);
      }
    }

    if (this.markerTimer > 0) {
      this.markerTimer -= dt;
      this.marker.rotation.y += dt * 2;
      if (this.markerTimer <= 0) this.marker.visible = false;
    }

    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  }

  updateCamera() {
    const self = this.entities.get(this.selfId);
    const focus = self ? self.mesh.position : this.selfPosition;
    const offsetX = Math.sin(this.cameraYaw) * Math.cos(this.cameraPitch) * this.cameraDistance;
    const offsetZ = Math.cos(this.cameraYaw) * Math.cos(this.cameraPitch) * this.cameraDistance;
    const offsetY = Math.sin(this.cameraPitch) * this.cameraDistance;
    this.camera.position.set(focus.x + offsetX, focus.y + offsetY, focus.z + offsetZ);
    this.camera.lookAt(focus.x, focus.y + 1.1, focus.z);
  }

  resize() {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  // --- Picking -------------------------------------------------------------

  /**
   * @returns {{kind:string, ...}|null} what is under the cursor, entities and
   * scenery taking priority over bare ground.
   */
  pick(ndcX, ndcY) {
    this.raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    const hits = this.raycaster.intersectObjects(
      [this.entityGroup, this.objectGroup, this.groundGroup, this.terrainGroup],
      true,
    );
    let terrainHit = null;
    for (const hit of hits) {
      const owner = findOwner(hit.object);
      if (!owner) continue;
      const kind = owner.userData.kind;
      if (kind === 'terrain' || kind === 'water') {
        if (!terrainHit) terrainHit = { kind: 'tile', x: Math.floor(hit.point.x + 0.5), y: Math.floor(hit.point.z + 0.5), point: hit.point };
        continue;
      }
      if (kind === 'entity') {
        const entity = this.entities.get(owner.userData.id);
        if (entity) return { kind: 'entity', id: owner.userData.id, entityKind: owner.userData.entityKind, data: entity.data };
      }
      if (kind === 'object') {
        return { kind: 'object', index: owner.userData.index, type: owner.userData.type };
      }
      if (kind === 'ground') {
        return { kind: 'ground', uid: owner.userData.uid, name: owner.userData.name };
      }
    }
    return terrainHit;
  }
}

// --- helpers ---------------------------------------------------------------

function findOwner(object) {
  let current = object;
  while (current) {
    if (current.userData?.kind) return current;
    current = current.parent;
  }
  return null;
}

function safeItem(id) {
  try {
    return getItem(id);
  } catch {
    return { name: id, value: 1 };
  }
}

function colourForItem(id) {
  if (id === 'coins') return 0xd4af37;
  if (id.includes('bones')) return 0xe8e2d0;
  if (id.includes('logs')) return 0x8a6a3a;
  if (id.includes('ore') || id === 'coal') return 0x9a7a5a;
  if (id.includes('rune')) return 0x7a5ad4;
  if (id.includes('raw_')) return 0xd4a08a;
  return 0xb0b6c0;
}

function labelTextFor(data) {
  if (data.kind === 'player') return `${data.name} (level ${data.combat})`;
  return data.level > 0 ? `${data.name} (level ${data.level})` : data.name;
}

const labelCache = new Map();

/** Text sprites are drawn to a 2D canvas and cached by their content. */
function makeLabel(text, options = {}) {
  const size = options.size ?? 20;
  const colour = options.colour ?? '#ffffff';
  const background = options.background ?? 'rgba(0,0,0,0.45)';
  const padding = options.padding ?? 8;
  const key = `${text}|${size}|${colour}|${background}|${padding}`;

  let texture = labelCache.get(key);
  if (!texture) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = `600 ${size}px "Trebuchet MS", system-ui, sans-serif`;
    const width = Math.ceil(context.measureText(text).width) + padding * 2;
    canvas.width = width;
    canvas.height = size + padding * 2;
    const ctx = canvas.getContext('2d');
    ctx.font = `600 ${size}px "Trebuchet MS", system-ui, sans-serif`;
    ctx.fillStyle = background;
    roundRect(ctx, 0, 0, canvas.width, canvas.height, 6);
    ctx.fill();
    ctx.fillStyle = colour;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, padding, canvas.height / 2);
    texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    labelCache.set(key, texture);
  }

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }),
  );
  sprite.scale.set((texture.image.width / texture.image.height) * 0.42, 0.42, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

/** Swing arms and legs while walking; play a one-shot pose while acting. */
function animateLimbs(mesh, speed, time, animation) {
  const parts = mesh.userData.parts;
  if (!parts) return;
  const { leftLeg, rightLeg, leftArm, rightArm, weapon } = parts;
  const walking = speed > 0.05;
  const swing = walking ? Math.sin(time * 11) * 0.6 : 0;
  if (leftLeg) leftLeg.rotation.x = swing;
  if (rightLeg) rightLeg.rotation.x = -swing;
  if (leftArm) leftArm.rotation.x = -swing * 0.8;
  if (rightArm) rightArm.rotation.x = swing * 0.8;

  if (animation && rightArm) {
    const phase = Math.sin(time * 20);
    if (animation.type === 'swing' || animation.type === 'chop' || animation.type === 'mine') {
      rightArm.rotation.x = -1.6 + phase * 0.7;
      if (weapon) weapon.rotation.x = -1.2 + phase * 0.6;
    } else if (animation.type === 'cast' || animation.type === 'shoot') {
      rightArm.rotation.x = -1.9;
      if (weapon) weapon.rotation.x = -0.4;
    } else if (animation.type === 'fish') {
      rightArm.rotation.x = -0.9 + phase * 0.2;
    }
  } else if (weapon) {
    weapon.rotation.x = 0;
  }
}
