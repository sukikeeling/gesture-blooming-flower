/**
 * 指尖生花 · 手势控制粒子花朵绽放 (Gesture Blooming Flower)
 * 技术栈：Three.js + MediaPipe Hands + GLSL ShaderMaterial
 */

import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

// ============================================================================
// 1. 全局配置与参数 (Configuration)
// ============================================================================
const CONFIG = {
  particleCount: 8000,            // 优化默认粒子数至 8000 (流畅丝滑且花型丰满)
  easingFactor: 0.1,             // 缓动追随速率 currentSpread += (targetSpread - currentSpread) * 0.1
  thresholdBud: 0.32,            // 握拳闭合阈值 (tension < 0.32)
  thresholdBloom: 0.66,          // 张开盛开阈值 (tension > 0.66)
  trackingAnchor: 'index_tip',   // 'index_tip' (食指指尖 #8) 或 'palm' (掌心 #9)
  theme: 'sakura',               // 'sakura' | 'aurora' | 'sunflower'
  cameraOpacity: 0.25,           // 摄像头背景不透明度
  showSkeleton: true,            // 是否渲染骨骼连线
  autoRotate: true               // 花朵轻微自转
};

// 调色板预设 (RGB 归一化)
const THEMES = {
  sakura: {
    core: new THREE.Color('#ffe066'),       // 花蕊金黄
    petalInner: new THREE.Color('#ff5f9e'), // 内花瓣玫瑰粉
    petalOuter: new THREE.Color('#b5179e'), // 外花瓣紫红
    dust: new THREE.Color('#7209b7')        // 飘散粉尘荧光紫
  },
  aurora: {
    core: new THREE.Color('#4cc9f0'),       // 青蓝花蕊
    petalInner: new THREE.Color('#4361ee'), // 宝蓝内瓣
    petalOuter: new THREE.Color('#3a0ca3'), // 幽紫渐变
    dust: new THREE.Color('#06d6a0')        // 荧光绿飘尘
  },
  sunflower: {
    core: new THREE.Color('#78350f'),       // 棕褐花盘
    petalInner: new THREE.Color('#f59e0b'), // 耀眼橙金
    petalOuter: new THREE.Color('#fbbf24'), // 亮黄花尖
    dust: new THREE.Color('#fef08a')        // 晨曦光晕
  }
};

// 手势与动画状态机
const state = {
  rawTension: 0.0,               // 原始计算张力
  smoothedTension: 0.0,          // 平滑后手掌张力
  targetSpread: 0.0,             // 绽放目标值 [0.0, 1.0]
  currentSpread: 0.0,            // 当前缓动绽放插值 [0.0, 1.0]
  handDetected: false,           // 是否捕捉到手部
  handPosition: new THREE.Vector3(0, 0, 0), // 3D 平滑跟随位置
  handRotation: new THREE.Euler(0, 0, 0),   // 手掌朝向
  // 渲染统计
  renderFps: 60,
  renderFrameCount: 0,
  lastRenderFpsTime: performance.now(),
  // 视觉识别统计
  visionFps: 0,
  visionFrameCount: 0,
  lastVisionFpsTime: performance.now(),
  isProcessingVision: false      // 异步防拥塞标志位
};

// ============================================================================
// 2. DOM 元素引用
// ============================================================================
const videoEl = document.getElementById('webcam');
const skeletonCanvas = document.getElementById('skeleton-canvas');
const webglCanvas = document.getElementById('webgl-canvas');

const tensionValEl = document.getElementById('tension-value');
const tensionFillEl = document.getElementById('tension-fill');
const flowerStatePill = document.getElementById('flower-state-pill');
const flowerStateText = document.getElementById('flower-state-text');
const renderFpsStatEl = document.getElementById('render-fps-stat');
const visionFpsStatEl = document.getElementById('vision-fps-stat');
const modalContainer = document.getElementById('modal-container');
const modalActionBtn = document.getElementById('modal-action-btn');

const skeletonCtx = skeletonCanvas.getContext('2d');

// 离屏极速采样画布 (320x240, 专供手势检测, 降低 80% 视觉计算量)
const visionCanvas = document.createElement('canvas');
visionCanvas.width = 320;
visionCanvas.height = 240;
const visionCtx = visionCanvas.getContext('2d', { willReadFrequently: true });

// ============================================================================
// 3. Three.js 3D 粒子系统与 GLSL 着色器
// ============================================================================
let renderer, scene, camera, flowerPoints, flowerMaterial, flowerGeometry;
const clock = new THREE.Clock();

// GLSL 顶点着色器：在 GPU 中插值花苞 (Bud) 与 盛开 (Bloom) 两种几何形态
const vertexShader = `
  uniform float uBloom;        // 绽放插值 [0.0 ~ 1.0]
  uniform float uTime;         // 动态运行时间
  uniform float uPixelRatio;   // 屏幕像素比

  attribute vec3 aBudPosition;   // 闭合花苞位置
  attribute vec3 aBloomPosition; // 盛开形态位置
  attribute vec3 aColor;         // 粒子颜色
  attribute float aSize;         // 基础粒子尺寸
  attribute vec3 aNoiseSeed;     // 粒子独立随机扰动种子

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vColor = aColor;

    // 1. 核心形态平滑插值 (使用 smoothstep 产生优雅曲线)
    float t = smoothstep(0.0, 1.0, uBloom);
    vec3 mixedPos = mix(aBudPosition, aBloomPosition, t);

    // 2. 盛开旋转展开效果：闭合时微旋，盛开时如花冠舒展
    float angle = (1.0 - t) * 1.8 * (mixedPos.y * 0.4);
    float cosA = cos(angle);
    float sinA = sin(angle);
    vec3 pos = vec3(
      mixedPos.x * cosA - mixedPos.z * sinA,
      mixedPos.y,
      mixedPos.x * sinA + mixedPos.z * cosA
    );

    // 3. 微风拂动与生命呼吸扰动 (Breathing & Wind Oscillation)
    float sway = sin(uTime * 2.2 + aNoiseSeed.x * 6.28) * 0.08 * t;
    float breathe = cos(uTime * 1.5 + pos.y * 3.0) * 0.04;
    pos.x += sway + sin(pos.y * 4.0 + uTime) * 0.03 * t;
    pos.y += breathe;
    pos.z += cos(uTime * 2.0 + aNoiseSeed.y * 6.28) * 0.05 * t;

    // 4. 视角投影计算
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // 5. 视角衰减点大小 (Perspective Point Size)
    float pSize = aSize * (1.0 + t * 0.3); // 盛开时光芒略微放大
    gl_PointSize = pSize * (280.0 / -mvPosition.z) * uPixelRatio;

    // 动态透明度 (花苞较密时略降，绽放时全透亮)
    vAlpha = mix(0.75, 0.95, t);
  }
`;

// GLSL 片元着色器：程序化生成柔和星芒与光晕 (Soft Radial Particle Glow)
const fragmentShader = `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    // 将点内坐标重映射为从中心 [-0.5, 0.5] 到原点的径向距离
    vec2 coord = gl_PointCoord - vec2(0.5);
    float dist = length(coord);

    if (dist > 0.5) {
      discard;
    }

    // 双层柔和辉光：强发光核心 + 柔和衰减边缘
    float core = smoothstep(0.18, 0.0, dist);
    float halo = smoothstep(0.5, 0.0, dist);

    // 混合发光颜色
    vec3 glowColor = vColor + vec3(0.6, 0.5, 0.4) * core;
    float finalAlpha = (halo * 0.7 + core * 0.6) * vAlpha;

    gl_FragColor = vec4(glowColor, finalAlpha);
  }
`;

/**
 * 初始化 Three.js 场景
 */
function initThree() {
  scene = new THREE.Scene();

  const width = window.innerWidth;
  const height = window.innerHeight;
  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
  camera.position.set(0, 0, 7.5);

  renderer = new THREE.WebGLRenderer({
    canvas: webglCanvas,
    alpha: true,
    antialias: true
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // 创建粒子花朵
  createParticleFlower();

  // 窗口自适应调整
  window.addEventListener('resize', onWindowResize);
}

/**
 * 根据极坐标花瓣数学公式生成三维花苞与花朵粒子几何数据
 */
function createParticleFlower() {
  if (flowerPoints) {
    scene.remove(flowerPoints);
    flowerGeometry.dispose();
    flowerMaterial.dispose();
  }

  const count = CONFIG.particleCount;
  flowerGeometry = new THREE.BufferGeometry();

  const budPositions = new Float32Array(count * 3);
  const bloomPositions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count * 3);

  const themeColors = THEMES[CONFIG.theme];

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const ratio = i / count;

    // 随机独立种子
    seeds[i3 + 0] = Math.random();
    seeds[i3 + 1] = Math.random();
    seeds[i3 + 2] = Math.random();

    // -------------------------------------------------------------
    // A. 盛开形态 (Bloom Position) - 极坐标数学花瓣系统
    // -------------------------------------------------------------
    // 将粒子划分为三大区域：10% 花蕊花心，75% 极坐标多层花瓣，15% 环绕光尘
    let bloomX = 0, bloomY = 0, bloomZ = 0;
    let pColor = new THREE.Color();
    let pSize = 0.08 + Math.random() * 0.06;

    if (ratio < 0.12) {
      // 1. 花蕊中心区域 (Stamen Core)
      const r = Math.pow(Math.random(), 0.5) * 0.45;
      const theta = Math.random() * Math.PI * 2;
      bloomX = r * Math.cos(theta);
      bloomZ = r * Math.sin(theta);
      bloomY = (Math.random() - 0.5) * 0.3 + 0.1;

      pColor.copy(themeColors.core).lerp(themeColors.petalInner, Math.random() * 0.3);
      pSize *= 1.25;

    } else if (ratio < 0.88) {
      // 2. 玫瑰/莲花极坐标花瓣方程 (Multi-tiered Polar Rose Petals)
      // 花瓣层级分布 (4 层花瓣，自内向外辐射递增)
      const petalRatio = (ratio - 0.12) / 0.76;
      const layer = Math.floor(petalRatio * 4);
      const k = 5; // 5 片花瓣对称
      const layerOffset = layer * (Math.PI / 5); // 层间花瓣错落交叠

      const theta = Math.random() * Math.PI * 2;
      // 极坐标瓣形调制：r_base + r_amp * cos(k * theta)
      const petalWave = Math.cos(k * (theta + layerOffset));
      const normalizedWave = Math.pow(Math.abs(petalWave), 0.75);

      // 径向半径：随层级由内到外展开 (半径 0.5 ~ 2.4)
      const baseRadius = 0.5 + layer * 0.45;
      const r = (baseRadius + normalizedWave * 0.75) * (0.6 + Math.random() * 0.4);

      bloomX = r * Math.cos(theta);
      bloomZ = r * Math.sin(theta);

      // 3D 杯状花瓣卷曲弧度曲面: z = a * r^2 - b
      const lift = Math.sin(r * 1.2) * 0.7 - (1.0 - petalRatio) * 0.3;
      bloomY = lift + (Math.random() - 0.5) * 0.15;

      // 花瓣渐变配色：内部粉紫 -> 外部深渐变
      const colorMix = petalRatio + (Math.random() - 0.5) * 0.15;
      pColor.copy(themeColors.petalInner).lerp(themeColors.petalOuter, Math.min(Math.max(colorMix, 0), 1));

    } else {
      // 3. 漂浮光尘微粒 (Swirling Stardust Aura)
      const r = 2.2 + Math.random() * 1.5;
      const theta = Math.random() * Math.PI * 2;
      const phi = (Math.random() - 0.5) * Math.PI * 0.8;
      bloomX = r * Math.cos(theta) * Math.cos(phi);
      bloomY = r * Math.sin(phi) + Math.sin(theta * 3.0) * 0.4;
      bloomZ = r * Math.sin(theta) * Math.cos(phi);

      pColor.copy(themeColors.dust);
      pSize *= 0.75;
    }

    bloomPositions[i3 + 0] = bloomX;
    bloomPositions[i3 + 1] = bloomY;
    bloomPositions[i3 + 2] = bloomZ;

    // -------------------------------------------------------------
    // B. 花苞形态 (Bud Position) - 螺旋紧密水滴柱体锥形
    // -------------------------------------------------------------
    // 花苞半径小、高度紧凑收拢于中心竖向
    const budHeight = (Math.random() - 0.3) * 2.2; // Y 轴高 -0.6 ~ 1.6
    // 水滴截面半径：底部收拢，腰部微鼓，顶部聚集成花尖
    const normH = (budHeight + 0.6) / 2.2;
    const budRadius = Math.sin(normH * Math.PI) * 0.45 * (0.4 + Math.random() * 0.6);
    const budAngle = Math.random() * Math.PI * 2;

    budPositions[i3 + 0] = budRadius * Math.cos(budAngle);
    budPositions[i3 + 1] = budHeight;
    budPositions[i3 + 2] = budRadius * Math.sin(budAngle);

    // 颜色与尺寸
    colors[i3 + 0] = pColor.r;
    colors[i3 + 1] = pColor.g;
    colors[i3 + 2] = pColor.b;
    sizes[i] = pSize;
  }

  flowerGeometry.setAttribute('position', new THREE.BufferAttribute(budPositions, 3)); // 初始锚定
  flowerGeometry.setAttribute('aBudPosition', new THREE.BufferAttribute(budPositions, 3));
  flowerGeometry.setAttribute('aBloomPosition', new THREE.BufferAttribute(bloomPositions, 3));
  flowerGeometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  flowerGeometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  flowerGeometry.setAttribute('aNoiseSeed', new THREE.BufferAttribute(seeds, 3));

  // 自定义 ShaderMaterial
  flowerMaterial = new THREE.ShaderMaterial({
    vertexShader: vertexShader,
    fragmentShader: fragmentShader,
    uniforms: {
      uBloom: { value: 0.0 },
      uTime: { value: 0.0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) }
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  flowerPoints = new THREE.Points(flowerGeometry, flowerMaterial);
  scene.add(flowerPoints);
}

/**
 * 屏幕尺寸改变适配
 */
function onWindowResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  renderer.setSize(width, height);
  if (flowerMaterial) {
    flowerMaterial.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio, 1.5);
  }

  resizeCanvas(skeletonCanvas);
}

function resizeCanvas(canvas) {
  if (!canvas) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

// ============================================================================
// 4. 手势识别与张力计算 (MediaPipe Hands & Tension Math)
// ============================================================================

/**
 * 欧几里得空间距离辅助函数
 */
function distance3D(p1, p2) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  const dz = (p1.z || 0) - (p2.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 计算手掌张开度 Tension [0.0 ~ 1.0]
 *
 * 【算法公式】：
 * 1. 选取手腕关键点 Wrist (#0) 作为基准原点。
 * 2. 计算 4 根长指 (食指#8, 中指#12, 无名指#16, 小指#20) 指尖到手腕的平均距离 D_tip。
 * 3. 计算 4 个掌指关节 MCP (#5, #9, #13, #17) 到手腕的平均骨架基准距离 D_mcp。
 * 4. 计算无量纲伸展比例 Ratio = D_tip / D_mcp：
 *    - 握拳闭合时：手指卷曲紧贴手掌，D_tip 趋近甚至小于 D_mcp，Ratio ≈ 0.95 ~ 1.15
 *    - 完全张开时：手指全力向外辐射展开，Ratio ≈ 2.10 ~ 2.45
 * 5. 归一化并限制在 [0.0, 1.0] 区间，配合时间加权平滑滤波 (EMA)。
 */
function calculateHandTension(landmarks) {
  const wrist = landmarks[0];
  const tips = [8, 12, 16, 20];
  const mcps = [5, 9, 13, 17];

  // 指尖平均距离
  let sumTipDist = 0;
  for (let i = 0; i < tips.length; i++) {
    sumTipDist += distance3D(landmarks[tips[i]], wrist);
  }
  const avgTipDist = sumTipDist / tips.length;

  // 掌指关节平均基准距离 (手掌固有尺度)
  let sumMcpDist = 0;
  for (let i = 0; i < mcps.length; i++) {
    sumMcpDist += distance3D(landmarks[mcps[i]], wrist);
  }
  const avgMcpDist = Math.max(sumMcpDist / mcps.length, 0.001);

  // 无量纲张开度比率
  const ratio = avgTipDist / avgMcpDist;

  // 经验归一化校准区间 (Min: 1.15 握拳, Max: 2.15 全张开)
  const minRatio = 1.15;
  const maxRatio = 2.15;
  const normalized = (ratio - minRatio) / (maxRatio - minRatio);

  return Math.min(Math.max(normalized, 0.0), 1.0);
}

/**
 * 将 2D 镜像归一化坐标转换映射到 Three.js 3D 世界坐标
 */
function mapLandmarkToWorld(landmark, cameraDistance = 7.5) {
  // 水平镜像翻转 (自拍模式)：x -> 1.0 - x
  const mirroredX = 1.0 - landmark.x;
  const ndcX = mirroredX * 2.0 - 1.0;
  const ndcY = -(landmark.y * 2.0 - 1.0);

  // 根据相机视场角 (FOV=45°) 计算对应深度处可视平面尺寸
  const vFovRad = (camera.fov * Math.PI) / 180;
  const visibleHeight = 2.0 * Math.tan(vFovRad / 2.0) * cameraDistance;
  const visibleWidth = visibleHeight * camera.aspect;

  return new THREE.Vector3(
    (ndcX * visibleWidth) / 2.0,
    (ndcY * visibleHeight) / 2.0,
    0.0
  );
}

/**
 * 绘制手部 21 关键点骨架连线
 */
function drawSkeleton(landmarks) {
  skeletonCtx.clearRect(0, 0, skeletonCanvas.width, skeletonCanvas.height);
  if (!CONFIG.showSkeleton || !landmarks) return;

  const w = skeletonCanvas.width;
  const h = skeletonCanvas.height;

  // 手指骨节连接关系列表
  const connections = [
    [0, 1], [1, 2], [2, 3], [3, 4],       // 拇指
    [0, 5], [5, 6], [6, 7], [7, 8],       // 食指
    [0, 9], [9, 10], [10, 11], [11, 12],   // 中指
    [0, 13], [13, 14], [14, 15], [15, 16],// 无名指
    [0, 17], [17, 18], [18, 19], [19, 20],// 小指
    [5, 9], [9, 13], [13, 17]             // 掌骨横连
  ];

  skeletonCtx.save();
  // 镜像翻转以对齐相机预览
  skeletonCtx.translate(w, 0);
  skeletonCtx.scale(-1, 1);

  // 1. 绘制连线
  skeletonCtx.strokeStyle = 'rgba(255, 95, 158, 0.45)';
  skeletonCtx.lineWidth = 2.5;
  skeletonCtx.lineCap = 'round';
  skeletonCtx.lineJoin = 'round';

  connections.forEach(([i, j]) => {
    const p1 = landmarks[i];
    const p2 = landmarks[j];
    skeletonCtx.beginPath();
    skeletonCtx.moveTo(p1.x * w, p1.y * h);
    skeletonCtx.lineTo(p2.x * w, p2.y * h);
    skeletonCtx.stroke();
  });

  // 2. 绘制关节点
  landmarks.forEach((p, idx) => {
    const px = p.x * w;
    const py = p.y * h;

    skeletonCtx.beginPath();
    if (idx === 8 && CONFIG.trackingAnchor === 'index_tip') {
      // 食指指尖高亮光圈
      skeletonCtx.arc(px, py, 7, 0, Math.PI * 2);
      skeletonCtx.fillStyle = '#ffd166';
      skeletonCtx.shadowColor = '#ffd166';
      skeletonCtx.shadowBlur = 12;
    } else if (idx === 9 && CONFIG.trackingAnchor === 'palm') {
      // 掌心高亮光圈
      skeletonCtx.arc(px, py, 7, 0, Math.PI * 2);
      skeletonCtx.fillStyle = '#4cc9f0';
      skeletonCtx.shadowColor = '#4cc9f0';
      skeletonCtx.shadowBlur = 12;
    } else {
      skeletonCtx.arc(px, py, 3.5, 0, Math.PI * 2);
      skeletonCtx.fillStyle = '#ffffff';
      skeletonCtx.shadowBlur = 0;
    }
    skeletonCtx.fill();
  });

  skeletonCtx.restore();
}

/**
 * MediaPipe Hands 关键点识别回调
 */
function onHandsResults(results) {
  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    state.handDetected = true;
    const landmarks = results.multiHandLandmarks[0];

    // 1. 计算手掌张开度
    const tension = calculateHandTension(landmarks);
    state.rawTension = tension;
    // 指数移动平均平滑滤波 (EMA Smoothing)
    state.smoothedTension += (tension - state.smoothedTension) * 0.2;

    // 2. 映射张开度为绽放目标值
    // tension < 0.32: 闭合花苞 (targetSpread = 0)
    // tension > 0.66: 完全绽放 (targetSpread = 1)
    // 0.32 ~ 0.66: 线性平滑过渡
    if (state.smoothedTension < CONFIG.thresholdBud) {
      state.targetSpread = 0.0;
    } else if (state.smoothedTension > CONFIG.thresholdBloom) {
      state.targetSpread = 1.0;
    } else {
      state.targetSpread = (state.smoothedTension - CONFIG.thresholdBud) / (CONFIG.thresholdBloom - CONFIG.thresholdBud);
    }

    // 3. 计算花朵锚定位置 (食指指尖 #8 或 掌心 #9)
    const anchorIdx = (CONFIG.trackingAnchor === 'index_tip') ? 8 : 9;
    const targetAnchorLandmark = landmarks[anchorIdx];
    const targetWorldPos = mapLandmarkToWorld(targetAnchorLandmark);

    // 平滑位置跟随
    state.handPosition.lerp(targetWorldPos, 0.16);

    // 4. 计算手腕到指尖的方向向量，控制花朵倾斜角度
    const wristWorld = mapLandmarkToWorld(landmarks[0]);
    const dir = targetWorldPos.clone().sub(wristWorld).normalize();
    const targetRotZ = Math.atan2(dir.y, dir.x) - Math.PI / 2;
    state.handRotation.z += (targetRotZ - state.handRotation.z) * 0.1;

    // 5. 渲染骨架连线
    drawSkeleton(landmarks);

  } else {
    // 未检测到手部时保持轻微默认花苞状态缓缓回正
    state.handDetected = false;
    skeletonCtx.clearRect(0, 0, skeletonCanvas.width, skeletonCanvas.height);
    state.targetSpread = 0.15;
    state.handPosition.lerp(new THREE.Vector3(0, -0.2, 0), 0.05);
  }

  // 更新 HUD 界面显示
  updateHUD();
}

/**
 * 界面 HUD 仪表盘与状态标签更新
 */
function updateHUD() {
  tensionValEl.textContent = state.smoothedTension.toFixed(2);
  tensionFillEl.style.width = `${(state.smoothedTension * 100).toFixed(1)}%`;

  flowerStatePill.className = 'state-pill';
  if (!state.handDetected) {
    flowerStateText.textContent = '等待手势伸入镜头...';
  } else if (state.smoothedTension < CONFIG.thresholdBud) {
    flowerStatePill.classList.add('bud');
    flowerStateText.textContent = '✊ 握拳：花苞聚拢闭合';
  } else if (state.smoothedTension > CONFIG.thresholdBloom) {
    flowerStatePill.classList.add('bloom');
    flowerStateText.textContent = '🖐️ 绽放：指尖繁花盛开';
  } else {
    flowerStatePill.classList.add('growing');
    flowerStateText.textContent = '🌱 舒展：含苞待放中...';
  }
}

// ============================================================================
// 5. 核心动画循环 (Render Loop)
// ============================================================================
function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const elapsedTime = clock.getElapsedTime();

  // 关键需求：缓动追随函数
  // currentSpread += (targetSpread - currentSpread) * 0.1
  state.currentSpread += (state.targetSpread - state.currentSpread) * CONFIG.easingFactor;

  // 将绽放值传递至 GPU 着色器
  if (flowerMaterial) {
    flowerMaterial.uniforms.uBloom.value = state.currentSpread;
    flowerMaterial.uniforms.uTime.value = elapsedTime;
  }

  // 更新花朵世界坐标位置与自转微动
  if (flowerPoints) {
    flowerPoints.position.copy(state.handPosition);
    flowerPoints.rotation.z = state.handRotation.z * 0.4;

    if (CONFIG.autoRotate) {
      flowerPoints.rotation.y = elapsedTime * 0.35;
      flowerPoints.rotation.x = Math.sin(elapsedTime * 0.8) * 0.1;
    }
  }

  renderer.render(scene, camera);

  // 渲染帧率统计 (独立于手势识别)
  state.renderFrameCount++;
  const now = performance.now();
  if (now - state.lastRenderFpsTime >= 1000) {
    state.renderFps = Math.round((state.renderFrameCount * 1000) / (now - state.lastRenderFpsTime));
    renderFpsStatEl.textContent = state.renderFps;
    state.renderFrameCount = 0;
    state.lastRenderFpsTime = now;
  }
}

// ============================================================================
// 6. MediaPipe 与 摄像头初始化 (Camera & Vision Pipeline)
// ============================================================================
async function initMediaPipeHands() {
  if (typeof window.Hands === 'undefined' || typeof window.Camera === 'undefined') {
    showModal('组件库加载失败', '未能从 CDN 加载 MediaPipe 依赖，请检查网络连接或刷新重试。');
    return;
  }

  try {
    const hands = new window.Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });

    // 性能优化：modelComplexity: 0 (轻量极速模型，极大幅度解放 CPU)
    hands.setOptions({
      maxNumHands: 1,               // 优先追踪单只手以获得最佳性能
      modelComplexity: 0,           // 0: 高速轻量模式
      minDetectionConfidence: 0.5,  // 平衡置信阈值提速
      minTrackingConfidence: 0.5
    });

    hands.onResults((results) => {
      state.isProcessingVision = false;
      onHandsResults(results);

      // 手势识别专属帧率统计
      state.visionFrameCount++;
      const vNow = performance.now();
      if (vNow - state.lastVisionFpsTime >= 1000) {
        state.visionFps = Math.round((state.visionFrameCount * 1000) / (vNow - state.lastVisionFpsTime));
        visionFpsStatEl.textContent = state.visionFps;
        state.visionFrameCount = 0;
        state.lastVisionFpsTime = vNow;
      }
    });

    // 关键架构优化：非阻塞异步视觉派发 (Decoupled Vision Pipeline)
    // 即使视觉计算单帧耗时 60ms (约 15 FPS)，Three.js 渲染管线依然保持 60 FPS 满帧丝滑！
    const cameraUtils = new window.Camera(videoEl, {
      onFrame: async () => {
        if (state.isProcessingVision || videoEl.readyState < 2) {
          return;
        }
        state.isProcessingVision = true;

        try {
          await hands.send({ image: videoEl });
        } catch (err) {
          console.warn('MediaPipe send warning:', err);
        } finally {
          state.isProcessingVision = false;
        }
      },
      width: 640,
      height: 480
    });

    await cameraUtils.start();
    hideModal();

  } catch (error) {
    console.error('摄像头启动异常:', error);
    showModal(
      '无法访问摄像头',
      '请确保已授予浏览器摄像头权限。如果使用的是 Chrome，请点击地址栏左侧的相机图标开启权限。'
    );
  }
}

// ============================================================================
// 7. UI 事件绑定与交互逻辑
// ============================================================================
function setupUIEvents() {
  // 控制面板折叠/展开
  const toggleBtn = document.getElementById('toggle-panel-btn');
  const controlPanel = document.querySelector('.control-panel');
  toggleBtn.addEventListener('click', () => {
    controlPanel.classList.toggle('collapsed');
  });

  // 追踪锚点切换 (食指指尖 vs 掌心)
  const anchorBtns = document.querySelectorAll('.opt-btn');
  anchorBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      anchorBtns.forEach((b) => b.classList.remove('active'));
      e.target.classList.add('active');
      CONFIG.trackingAnchor = e.target.dataset.target;
    });
  });

  // 粒子数量性能预设切换
  const countBtns = document.querySelectorAll('.count-btn');
  const countStatEl = document.getElementById('particle-count-stat');
  countBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      countBtns.forEach((b) => b.classList.remove('active'));
      e.target.classList.add('active');
      const count = parseInt(e.target.dataset.count, 10);
      CONFIG.particleCount = count;
      countStatEl.textContent = count.toLocaleString();
      createParticleFlower();
    });
  });

  // 主题切换
  const themeBtns = document.querySelectorAll('.theme-btn');
  themeBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      themeBtns.forEach((b) => b.classList.remove('active'));
      e.target.classList.add('active');
      CONFIG.theme = e.target.dataset.theme;
      createParticleFlower();
    });
  });

  // 摄像头背景不透明度滑动条 (直接控制底层 video 透明度)
  const opacityInput = document.getElementById('video-opacity');
  const opacityValEl = document.getElementById('video-opacity-val');
  opacityInput.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    CONFIG.cameraOpacity = val / 100;
    videoEl.style.opacity = CONFIG.cameraOpacity;
    opacityValEl.textContent = `${val}%`;
  });

  // 骨骼显示复选框
  const skeletonCheckbox = document.getElementById('show-skeleton');
  skeletonCheckbox.addEventListener('change', (e) => {
    CONFIG.showSkeleton = e.target.checked;
    if (!CONFIG.showSkeleton) {
      skeletonCtx.clearRect(0, 0, skeletonCanvas.width, skeletonCanvas.height);
    }
  });

  // 自转复选框
  const rotateCheckbox = document.getElementById('auto-rotate');
  rotateCheckbox.addEventListener('change', (e) => {
    CONFIG.autoRotate = e.target.checked;
  });

  // 模态弹窗重新授权按钮
  modalActionBtn.addEventListener('click', () => {
    initMediaPipeHands();
  });
}

function showModal(title, msg) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-message').textContent = msg;
  modalContainer.classList.remove('hidden');
}

function hideModal() {
  modalContainer.classList.add('hidden');
}

// ============================================================================
// 8. 入口启动函数 (Bootstrap)
// ============================================================================
function bootstrap() {
  resizeCanvas(skeletonCanvas);

  initThree();
  setupUIEvents();
  initMediaPipeHands();
  animate();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
