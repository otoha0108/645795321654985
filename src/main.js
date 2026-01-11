import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeeeeee);
scene.fog = new THREE.Fog(0xeeeeee, 8, 60);

// camera (3rd person)
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
document.body.style.margin = "0";
document.body.appendChild(renderer.domElement);

// orbit camera (mouse drag / touch drag)
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 2.5;
controls.maxDistance = 10;
controls.maxPolarAngle = Math.PI * 0.49;

// initial camera placement
camera.position.set(0, 2.2, 4.2);
controls.target.set(0, 1.2, 0);
controls.update();

// light
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.8));

const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
dirLight.position.set(6, 12, 6);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(1024, 1024);
scene.add(dirLight);

// ground
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0xbfbfbf })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// grid（動いた感が一発で出る）
const grid = new THREE.GridHelper(200, 200, 0x666666, 0x999999);
scene.add(grid);

const axes = new THREE.AxesHelper(2);
axes.position.y = 0.01;
scene.add(axes);

// simple props (so movement is obvious)
const propMat = new THREE.MeshStandardMaterial({ color: 0x7a7a7a });
function addBox(w, h, d, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), propMat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  scene.add(m);
  return m;
}

// a few landmarks
addBox(1.5, 1.5, 1.5, 3, 0, -3);
addBox(1.5, 3.0, 1.5, -4, 0, -8);
addBox(8.0, 0.4, 2.0, 0, 0, -6); // bench-ish
addBox(0.4, 1.0, 0.4, -3, 0, 4);
addBox(0.4, 1.0, 0.4, 3, 0, 4);

// player root (movement/rotation lives here)
const player = new THREE.Group();
scene.add(player);

// placeholder capsule (visible until VRM loads)
const body = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.3, 1.1, 6, 12),
  new THREE.MeshStandardMaterial({ color: 0x888888 })
);
body.position.y = 1.0;
body.castShadow = true;
player.add(body);

// VRM mount point (we attach the avatar here when loaded)
const avatarRoot = new THREE.Group();
player.add(avatarRoot);
const avatarForwardLean = 0; // リセットしてまっすぐ立たせる

let currentVrm = null;
let walkTime = 0;
let idleTime = 0;
const boneRestRotations = new Map();
const boneRestPositions = new Map();
let verticalVel = 0;
const gravity = -12;
const jumpSpeed = 6;
let motionMixer = null;
let currentAction = null;
let loggedRetargetInfo = false;
const targetVel = new THREE.Vector3();
const vel = new THREE.Vector3();
const accel = 12; // 加速
const decel = 10; // 減速
let facingYaw = 0;
const lerpAngle = (a, b, t) => {
  const delta = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  return a + delta * t;
};

function loadVRM(url) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.crossOrigin = "anonymous";

  loader
    .loadAsync(url)
    .then((gltf) => {
      const vrm = gltf.userData?.vrm;
      console.log("VRM:", vrm);

      if (!vrm) {
        console.warn("VRM data missing in glTF. Falling back to raw scene.");
        avatarRoot.clear();
        avatarRoot.add(gltf.scene);
        gltf.scene.position.set(0, 1.0, 0);
        gltf.scene.traverse((obj) => {
          if (obj.isMesh) {
            obj.frustumCulled = false;
            obj.castShadow = true;
            obj.receiveShadow = true;
          }
        });
        body.visible = false;
        currentVrm = null;
        return;
      }

      // VRM 0.x は -Z 前提なので回転を正す
      if (vrm.meta?.metaVersion === "0") {
        VRMUtils.rotateVRM0(vrm);
      }

      // 不要頂点・ジョイントを削って WebGL を軽くする
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.removeUnnecessaryJoints(gltf.scene);

      avatarRoot.clear();
      avatarRoot.add(vrm.scene);

      vrm.scene.scale.setScalar(1.0);
      vrm.scene.position.set(0, 1.0, 0);
      vrm.scene.rotation.set(0, 0, 0);

      vrm.scene.traverse((obj) => {
        if (obj.isMesh) {
          obj.frustumCulled = false;
          obj.castShadow = true;
          obj.receiveShadow = true;
        }
      });

      body.visible = false;
      nose.visible = false;
      currentVrm = vrm;
      motionMixer = new THREE.AnimationMixer(vrm.scene);

      // 髪の毛などのスプリングボーンに重力を強めにかける
      const springBones = vrm.springBoneManager?.joints;
      if (springBones) {
        springBones.forEach((joint) => {
          joint.settings.gravityDir.set(0, -1, 0);
          joint.settings.gravityPower = 1.0; // 重さを増やす
          joint.settings.dragForce = 0.5; // 振動を抑える
        });
        vrm.springBoneManager.setInitState();
      }

      // 変換済みGLBモーションをロードする場合はここで
      // loadMotion("/24Shibuya_Stand3_YoungMan_loop_HIK_24fps.glb");
    })
    .catch((err) => {
      console.error("Failed to load VRM:", err);
    });
}

// Expect a file at: /public/avatar.vrm  ->  URL is /avatar.vrm
loadVRM("/avatar.vrm");

// 前方向マーカー（どっち向いてるか分かる）
const nose = new THREE.Mesh(
  new THREE.SphereGeometry(0.08, 12, 12),
  new THREE.MeshStandardMaterial({ color: 0xff4444 })
);
nose.position.set(0, 1.2, -0.35);
player.add(nose);
nose.visible = true;

// input
const keys = new Set();
const moveKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space"]);
window.addEventListener("keydown", (e) => {
  if (moveKeys.has(e.code)) e.preventDefault();
  keys.add(e.code);
});
window.addEventListener("keyup", (e) => {
  if (moveKeys.has(e.code)) e.preventDefault();
  keys.delete(e.code);
});

const speed = 2.2; // 走り専用の移動速度（控えめに）
const clock = new THREE.Clock();

function update(dt) {
  // input in local space (WASD) then convert to camera-relative on XZ plane
  const input = new THREE.Vector3(
    (keys.has("KeyD") ? 1 : 0) + (keys.has("KeyA") ? -1 : 0),
    0,
    (keys.has("KeyS") ? 1 : 0) + (keys.has("KeyW") ? -1 : 0)
  );

  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

  const dir = new THREE.Vector3();
  dir.addScaledVector(right, input.x);
  dir.addScaledVector(forward, -input.z); // W is -z in input
  if (dir.lengthSq() > 0) dir.normalize();

  // velocity with smoothing (inertia)
  targetVel.copy(dir).multiplyScalar(speed);
  const factor = dt * (dir.lengthSq() > 0 ? accel * 0.6 : decel * 0.5); // ためと減速を少し長めに
  vel.lerp(targetVel, Math.min(factor, 1));
  player.position.addScaledVector(vel, dt);

  const moveSpeed = vel.length();
  const isMoving = moveSpeed > 1e-3;
  const stride = Math.min(moveSpeed / (speed * 0.7), 1); // 0..1

  if (isMoving) {
    const targetYaw = Math.atan2(vel.x, vel.z) + Math.PI;
    facingYaw = lerpAngle(facingYaw, targetYaw, Math.min(dt * 4.0, 1)); // 向きは少し遅れて回る
    player.rotation.y = facingYaw;
  }

  // jump physics
  const grounded = player.position.y <= 0.0001;
  if (grounded) {
    player.position.y = 0;
    verticalVel = 0;
    if (keys.has("Space")) {
      verticalVel = jumpSpeed;
    }
  }
  verticalVel += gravity * dt;
  player.position.y = Math.max(0, player.position.y + verticalVel * dt);

  if (motionMixer) {
    motionMixer.update(dt);
  }

  // keep orbit target on the player
  controls.target.set(player.position.x, player.position.y + 1.2, player.position.z);
  controls.update();

  document.title = `x:${player.position.x.toFixed(2)} z:${player.position.z.toFixed(2)}`;

  if (currentVrm) {
    currentVrm.update(dt);
    // if you want: make the red nose marker disappear once VRM is loaded
    nose.visible = false;
    const playingMotion = currentAction?.isRunning ? currentAction.isRunning() : !!currentAction;
    if (playingMotion) {
      avatarRoot.rotation.set(0, 0, 0); // モーション時は前傾リセット
    } else {
      avatarRoot.rotation.x = avatarForwardLean;
      const swingPhase = walkTime * 1.6;
      const moveSpeed = vel.length();
      const stride = Math.min(moveSpeed / (speed * 0.7), 1); // 0..1
      if (isMoving) {
        walkTime += dt * (1.0 + stride * 0.5);
      } else {
        walkTime = Math.max(0, walkTime - dt * 0.5);
      }
      // body bob
      const bodyBob = isMoving ? Math.sin(swingPhase * 2.0) * 0.02 * stride : 0;
      avatarRoot.position.y = bodyBob;
      animateHumanoid(currentVrm, dt, isMoving, grounded, stride, swingPhase);
    }
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  update(dt);
  renderer.render(scene, camera);
}
animate();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function loadMotion(url) {
  const loader = new GLTFLoader();
      loader.load(
        url,
        (gltf) => {
          if (!currentVrm || !motionMixer) return;
          const clip = gltf.animations?.[0];
      if (!clip) {
        console.warn("No animation clip found in motion:", url);
        return;
      }
          const retargeted = retargetClipToVRM(clip, currentVrm.humanoid);
          const action = motionMixer.clipAction(retargeted || clip);
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.clampWhenFinished = false;
          action.reset().fadeIn(0.25).play();
      if (currentAction && currentAction !== action) {
        currentAction.fadeOut(0.2);
      }
      currentAction = action;
    },
    undefined,
    (err) => {
      console.error("Failed to load motion:", err);
    }
  );
}

function applyBoneOffset(bone, eulerOffset, lerp = 0.2) {
  if (!bone) return;
  if (!boneRestRotations.has(bone)) {
    boneRestRotations.set(bone, bone.quaternion.clone());
  }
  const rest = boneRestRotations.get(bone);
  const target = rest.clone().multiply(new THREE.Quaternion().setFromEuler(eulerOffset));
  bone.quaternion.slerp(target, lerp);
}

function applyBonePositionOffset(bone, offset, lerp = 0.2) {
  if (!bone) return;
  if (!boneRestPositions.has(bone)) {
    boneRestPositions.set(bone, bone.position.clone());
  }
  const rest = boneRestPositions.get(bone);
  const target = rest.clone().add(offset);
  bone.position.lerp(target, lerp);
}

function animateHumanoid(vrm, dt, isMoving, grounded, stride = 0, swingPhase = 0) {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;

  // 全身の前傾（VRMだけ傾ける）
  avatarRoot.rotation.x = avatarForwardLean;

  const leftArm = humanoid.getNormalizedBoneNode("leftUpperArm");
  const rightArm = humanoid.getNormalizedBoneNode("rightUpperArm");
  const leftForeArm = humanoid.getNormalizedBoneNode("leftLowerArm");
  const rightForeArm = humanoid.getNormalizedBoneNode("rightLowerArm");
  const leftLeg = humanoid.getNormalizedBoneNode("leftUpperLeg");
  const rightLeg = humanoid.getNormalizedBoneNode("rightUpperLeg");
  const leftShin = humanoid.getNormalizedBoneNode("leftLowerLeg");
  const rightShin = humanoid.getNormalizedBoneNode("rightLowerLeg");
  const hips = humanoid.getNormalizedBoneNode("hips");
  const spine =
    humanoid.getNormalizedBoneNode("spine") ||
    humanoid.getNormalizedBoneNode("chest") ||
    humanoid.getNormalizedBoneNode("upperChest") ||
    humanoid.getNormalizedBoneNode("hips");
  const neck = humanoid.getNormalizedBoneNode("neck") || humanoid.getNormalizedBoneNode("head");
  const head = humanoid.getNormalizedBoneNode("head");
  const leftFoot = humanoid.getNormalizedBoneNode("leftFoot");
  const rightFoot = humanoid.getNormalizedBoneNode("rightFoot");

  const isIdle = !isMoving && grounded;
  if (isIdle) {
    idleTime += dt;
  } else {
    idleTime = 0;
  }
  const moveFactor = isMoving ? 1.0 : 0.0;

  // idleへ戻すレート
  const blend = isMoving ? 0.35 : 0.15;

  if (isMoving) {
    walkTime += dt * 3.0; // 少しゆっくりめの周期に
  } else {
    walkTime = Math.max(0, walkTime - dt * 4);
  }

  const isJumping = !grounded;

  // 腕は待機時まっすぐ、走行時だけ強く曲げる
  let armDownZ = 1.0;
  let armSwing = isJumping ? 0 : Math.sin(swingPhase) * (stride * 0.35);
  let armRaiseX = isJumping ? 0.3 : 0.0; // 基本はまっすぐ下ろす
  let armBend = isJumping ? 0.0 : 0.0; // 待機はまっすぐ
  if (!isJumping && isMoving) {
    armSwing *= 1.2;
    armRaiseX = 0.25;
    armBend = 0.9; // 走行時のみ深く曲げる
    armDownZ = 0.95;
  }
  applyBoneOffset(leftArm, new THREE.Euler(armRaiseX + armSwing * 0.6, 0, armDownZ), blend);
  applyBoneOffset(rightArm, new THREE.Euler(armRaiseX - armSwing * 0.6, 0, -armDownZ), blend);
  applyBoneOffset(leftForeArm, new THREE.Euler(armBend, 0, 0), blend);
  applyBoneOffset(rightForeArm, new THREE.Euler(armBend, 0, 0), blend);
  // 手首は前後（X）方向に少し曲げるだけに戻す
  const handTwist = isIdle ? 0.2 : 0.2; // 軽く内側へ
  const handBend = isIdle ? 0.1 : 0.1;
  const leftHand = humanoid.getNormalizedBoneNode("leftHand");
  const rightHand = humanoid.getNormalizedBoneNode("rightHand");
  applyBoneOffset(leftHand, new THREE.Euler(handBend, handTwist, 0), blend);
  applyBoneOffset(rightHand, new THREE.Euler(handBend, -handTwist, 0), blend);

  if (isJumping) {
    // ジャンプ時は少しだけたたむ
    const baseLegTilt = -0.2;
    const rightLegTilt = baseLegTilt - 0.1;
    const leftLegTilt = baseLegTilt + 0.1;
    const kneeBend = -0.6;
    applyBoneOffset(leftLeg, new THREE.Euler(leftLegTilt, 0, 0), blend);
    applyBoneOffset(rightLeg, new THREE.Euler(rightLegTilt, 0, 0), blend);
    applyBoneOffset(leftShin, new THREE.Euler(kneeBend, 0, 0), blend);
    applyBoneOffset(rightShin, new THREE.Euler(kneeBend, 0, 0), blend);
  } else {
    // 歩行も待機も近い姿勢をベースに、控えめスイング（走る時は少し強め）
    const backToRest = 0.2;
    const baseKnee = isMoving ? -1.2 : -0.12; // 走行時の膝を大きく曲げる、待機はまっすぐ寄り
    const baseLegTilt = isMoving ? 0.03 : 0.0;
    const baseSpread = isMoving ? 0.1 : 0.08;
    const legSwing = isMoving ? Math.sin(swingPhase + Math.PI) * (0.25 * stride) : 0.0; // 振り幅控えめ
    applyBoneOffset(leftLeg, new THREE.Euler(baseLegTilt + legSwing, baseSpread, 0), backToRest);
    applyBoneOffset(rightLeg, new THREE.Euler(baseLegTilt - legSwing, -baseSpread, 0), backToRest);
    applyBoneOffset(leftShin, new THREE.Euler(baseKnee, 0, 0), backToRest);
    applyBoneOffset(rightShin, new THREE.Euler(baseKnee, 0, 0), backToRest);
    applyBoneOffset(leftFoot, new THREE.Euler(0.05, 0.08, 0), backToRest);
    applyBoneOffset(rightFoot, new THREE.Euler(0.05, -0.08, 0), backToRest);
    const footLiftL = isMoving ? Math.max(0, Math.sin(swingPhase + Math.PI)) * 0.02 * stride : 0;
    const footLiftR = isMoving ? Math.max(0, Math.sin(swingPhase)) * 0.02 * stride : 0;
    applyBonePositionOffset(leftFoot, new THREE.Vector3(0, footLiftL, 0), backToRest);
    applyBonePositionOffset(rightFoot, new THREE.Vector3(0, footLiftR, 0), backToRest);
  }

  // 上半身を少し前傾（立ち時は猫背気味、ジャンプ時は深め）
  if (spine) {
    const torsoLean = isJumping ? -0.25 : -0.18; // 自然な前傾に統一
    const idleSway = isIdle ? Math.sin(idleTime * 1.6) * 0.05 : 0;
    const idleBreath = isIdle ? Math.sin(idleTime * 2.0) * 0.03 : 0;
    const torsoRoll = moveFactor ? Math.sin(swingPhase) * 0.025 * stride : 0; // 軽い体重移動
    applyBoneOffset(spine, new THREE.Euler(torsoLean + idleBreath, idleSway, torsoRoll), blend);
  }

  // 腰をひねって前方向のニュアンスを出す（位置は動かさない）
  if (hips) {
    const hipPitch = isJumping ? 0.15 : 0.12; // 控えめな前押し
    const hipYaw = moveFactor ? Math.sin(swingPhase + Math.PI * 0.5) * 0.03 * stride : 0; // 軽いヨー
    const hipRoll = moveFactor ? Math.sin(swingPhase) * -0.03 * stride : 0; // 体重移動のロール
    applyBoneOffset(hips, new THREE.Euler(hipPitch, hipYaw, hipRoll), blend);
  }

  // 指を軽く丸めてピンと伸びるのを防ぐ
  relaxFingers(humanoid, isIdle ? 0.35 : 0.2);

  // 首と頭を少し前に倒す
  if (neck) {
    const neckLean = -0.08; // 常に軽く前倒し
    applyBoneOffset(neck, new THREE.Euler(neckLean, 0, 0), blend);
  }
  if (head) {
    const headLean = 0.1; // 常に少し上向き
    applyBoneOffset(head, new THREE.Euler(headLean, 0, 0), blend);
    const headBob = moveFactor ? Math.sin(swingPhase * 2.0) * 0.008 * stride : 0;
    applyBonePositionOffset(head, new THREE.Vector3(0, headBob, 0), blend);
  }
}

function relaxFingers(humanoid, blend = 0.2) {
  const fingerBones = [
    "thumbProximal",
    "thumbIntermediate",
    "thumbDistal",
    "indexProximal",
    "indexIntermediate",
    "indexDistal",
    "middleProximal",
    "middleIntermediate",
    "middleDistal",
    "ringProximal",
    "ringIntermediate",
    "ringDistal",
    "littleProximal",
    "littleIntermediate",
    "littleDistal",
  ];

  const curl = new THREE.Euler(-0.35, 0, 0); // 前に丸める
  ["left", "right"].forEach((side) => {
    fingerBones.forEach((name) => {
      const bone = humanoid.getNormalizedBoneNode(`${side}${name[0].toUpperCase()}${name.slice(1)}`) || humanoid.getNormalizedBoneNode(`${side}_${name}`);
      if (bone) {
        applyBoneOffset(bone, curl, blend);
      }
    });
  });
}

function retargetClipToVRM(clip, humanoid) {
  if (!clip || !humanoid) return null;

  // HIK/Mixamo系 -> VRM Humanoid 名マップ
  const map = {
    hips: "hips",
    spine: "spine",
    spine1: "chest",
    spine2: "upperChest",
    spine3: "upperChest",
    spine4: "upperChest",
    neck: "neck",
    neck1: "neck",
    head: "head",
    leftupleg: "leftUpperLeg",
    leftleg: "leftLowerLeg",
    leftfoot: "leftFoot",
    rightupleg: "rightUpperLeg",
    rightleg: "rightLowerLeg",
    rightfoot: "rightFoot",
    leftshoulder: "leftShoulder",
    leftarm: "leftUpperArm",
    leftforearm: "leftLowerArm",
    lefthand: "leftHand",
    rightshoulder: "rightShoulder",
    rightarm: "rightUpperArm",
    rightforearm: "rightLowerArm",
    righthand: "rightHand",
    lefttoebase: "leftToes",
    righttoebase: "rightToes",
    lefttoe: "leftToes",
    righttoe: "rightToes",
    leftinhandindex: "leftHand",
    leftinhandmiddle: "leftHand",
    leftinhandring: "leftHand",
    leftinhandpinky: "leftHand",
    rightinhandindex: "rightHand",
    rightinhandmiddle: "rightHand",
    rightinhandring: "rightHand",
    rightinhandpinky: "rightHand",
    leftindex1: "leftIndexProximal",
    leftindex2: "leftIndexIntermediate",
    leftindex3: "leftIndexDistal",
    leftmiddle1: "leftMiddleProximal",
    leftmiddle2: "leftMiddleIntermediate",
    leftmiddle3: "leftMiddleDistal",
    leftring1: "leftRingProximal",
    leftring2: "leftRingIntermediate",
    leftring3: "leftRingDistal",
    leftpinky1: "leftLittleProximal",
    leftpinky2: "leftLittleIntermediate",
    leftpinky3: "leftLittleDistal",
    leftthumb1: "leftThumbMetacarpal",
    leftthumb2: "leftThumbProximal",
    leftthumb3: "leftThumbDistal",
    rightindex1: "rightIndexProximal",
    rightindex2: "rightIndexIntermediate",
    rightindex3: "rightIndexDistal",
    rightmiddle1: "rightMiddleProximal",
    rightmiddle2: "rightMiddleIntermediate",
    rightmiddle3: "rightMiddleDistal",
    rightring1: "rightRingProximal",
    rightring2: "rightRingIntermediate",
    rightring3: "rightRingDistal",
    rightpinky1: "rightLittleProximal",
    rightpinky2: "rightLittleIntermediate",
    rightpinky3: "rightLittleDistal",
    rightthumb1: "rightThumbMetacarpal",
    rightthumb2: "rightThumbProximal",
    rightthumb3: "rightThumbDistal",
  };

  // FBX→GLTFで軸ずれしている場合用のヒップ回転補正（90°前屈方向）
  // ヒップのみ前屈方向に90°補正、脚は左右で別オフセット
  const hipRotationOffset = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
  const legRotationOffsetLeft = new THREE.Quaternion(); // 左脚は補正なし
  const legRotationOffsetRight = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0)); // 右脚全体を180度回転
  const rightFootOffset = new THREE.Quaternion(); // 足首補正なしに戻す

  const tracks = [];
  clip.tracks.forEach((track) => {
    const parts = track.name.split(".");
    const srcName = parts[0];
    const rest = parts.slice(1).join(".");
    // 回転以外（position/scale）は VRM を飛ばす可能性があるので無視
    if (!rest.toLowerCase().includes("quaternion")) return;
    const vrmName = map[srcName.toLowerCase()];
    if (!vrmName) return;
    const node = humanoid.getNormalizedBoneNode(vrmName);
    if (!node) return;
    const cloned = track.clone();
    cloned.name = `${node.name}.${rest}`;

    // ヒップと太腿の回転軸を補正
    if (cloned instanceof THREE.QuaternionKeyframeTrack) {
      if (vrmName === "hips" || vrmName === "leftUpperLeg" || vrmName === "rightUpperLeg") {
        const v = cloned.values;
        const offset =
          vrmName === "hips"
            ? hipRotationOffset
            : vrmName === "leftUpperLeg"
            ? legRotationOffsetLeft
            : legRotationOffsetRight;
        for (let i = 0; i < v.length; i += 4) {
          const q = new THREE.Quaternion(v[i], v[i + 1], v[i + 2], v[i + 3]);
          q.premultiply(offset);
          v[i] = q.x;
          v[i + 1] = q.y;
          v[i + 2] = q.z;
          v[i + 3] = q.w;
        }
      }

      // 右足首だけ下向きに回転
      if (vrmName === "rightFoot") {
        const v = cloned.values;
        for (let i = 0; i < v.length; i += 4) {
          const q = new THREE.Quaternion(v[i], v[i + 1], v[i + 2], v[i + 3]);
          q.premultiply(rightFootOffset);
          v[i] = q.x;
          v[i + 1] = q.y;
          v[i + 2] = q.z;
          v[i + 3] = q.w;
        }
      }
    }

    tracks.push(cloned);
  });

  if (!loggedRetargetInfo) {
    loggedRetargetInfo = true;
    const srcSet = new Set(clip.tracks.map((t) => t.name.split(".")[0]));
    console.log("[retarget] source bones:", Array.from(srcSet));
    console.log("[retarget] mapped bones:", tracks.map((t) => t.name.split(".")[0]));
  }

  if (tracks.length === 0) return null;
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}
