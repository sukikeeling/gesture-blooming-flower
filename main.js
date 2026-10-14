import * as THREE from 'three';

/**
 * ============================================================================
 * 一、 全局可配置参数 (可根据创意需求自由调整)
 * ============================================================================
 */
const CONFIG = {
  // 粒子与花朵数学参数
  particleCount: 15000,         // 初始粒子数量 (支持 5000 ~ 20000 动态重建)
  petalCount: 6,                // 花瓣阶数 (极坐标玫瑰线参数 k)
  flowerRadius: 2.35,           // 花朵完全绽放时的最大半径
  budRadius: 0.42,              // 花苞闭合时的紧凑半径
  basePointSize: 28.0,          // 粒子基础大小

  // 手势张开度 (Tension) 归一化与阈值参数
  ratioMin: 0.85,               // 握拳时 指尖到手腕距离 / 掌指关节到手腕距离 的经验下限
  ratioMax: 2.05,               // 张开手掌时的经验上限
  tensionSmoothing: 0.25,       // Tension 指数平滑系数
  budThreshold: 0.32,           // tension < 0.32 判定为花苞闭合
  bloomThreshold: 0.66,         // tension > 0.66 判定为完全绽放

  // 缓动与位置跟随参数
  spreadEasing: 0.1,            // 题目要求: currentSpread += (targetSpread - currentSpread) * 0.1
  positionLerp: 0.14,           // 花朵中心跟随手部位置的平滑系数

  // 视觉开关
  showSkeleton: true,           // 是否绘制手部 21 关键点连线
  manualMode: false             // 是否启用免摄像头手动调试模式
};

/**
 * ============================================================================
 * 二、 运行时状态数据
 * ============================================================================
 */
const STATE = {
  tension: 0.0,                 // 平滑后的手掌张开度 (0 ~ 1)
  targetSpread: 0.0,            // 目标绽放度 (0 ~ 1)
  currentSpread: 0.0,           // 当前缓动绽放度 (0 ~ 1)
  handDetected: false,          // 当前帧是否检测到手部
  handActivity: 0.0,            // 手部激活权重 (0 ~ 1 平滑过渡)
  targetCenter: new THREE.Vector3(0, 0, 0), // 目标花朵 3D 中心
  currentCenter: new THREE.Vector3(0, 0, 0),// 当前花朵 3D 中心
  fingertipsWorld: [            // 5 个指尖在 Three.js 世界坐标系下的位置
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3()
  ]
};

/**
 * ============================================================================
 * 三、 DOM 元素引用
 * ============================================================================
 */
const dom = {
  video: document.getElementById('webcam-video'),
  landmarkCanvas: document.getElementById('landmark-canvas'),
  webglContainer: document.getElementById('webgl-container'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  tensionValue: document.getElementById('tension-value'),
  tensionBar: document.getElementById('tension-bar'),
  spreadValue: document.getElementById('spread-value'),
  spreadBar: document.getElementById('spread-bar'),
  gestureBadge: document.getElementById('gesture-state-badge'),
  particleSlider: document.getElementById('particle-count-slider'),
  particleVal: document.getElementById('particle-count-val'),
  petalSlider: document.getElementById('petal-count-slider'),
  petalVal: document.getElementById('petal-count-val'),
  opacitySlider: document.getElementById('video-opacity-slider'),
  opacityVal: document.getElementById('video-opacity-val'),
  toggleSkeleton: document.getElementById('toggle-skeleton'),
  toggleManual: document.getElementById('toggle-manual'),
  manualWrapper: document.getElementById('manual-slider-wrapper'),
  manualSlider: document.getElementById('manual-tension-slider'),
  manualVal: document.getElementById('manual-tension-val'),
  errorModal: document.getElementById('error-modal'),
  errorMessage: document.getElementById('error-message'),
  retryCameraBtn: document.getElementById('retry-camera-btn'),
  useManualBtn: document.getElementById('use-manual-btn')
};

const landmarkCtx = dom.landmarkCanvas.getContext('2d');

/**
 * ============================================================================
 * 四、 GLSL 顶点着色器与片元着色器
 * ============================================================================
 */
const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uSpread;
  uniform float uPixelRatio;
  uniform float uBaseSize;
  uniform float uHandActivity;
  uniform vec3 uFlowerCenter;
  uniform vec3 uFingertips[5];

  attribute vec3 aPositionBloom;
  attribute vec3 aColor;
  attribute vec3 aRandom; // x: 随机相位, y: 径向归一化层级(0~1), z: 粒子尺寸缩放

  varying vec3 vColor;
  varying float vAlpha;

  // 2D 旋转矩阵
  mat2 rotate2d(float angle) {
    float s = sin(angle);
    float c = cos(angle);
    return mat2(c, -s, s, c);
  }

  void main() {
    vColor = aColor;

    // 1. 让内外层花瓣产生错落有致的绽放节奏（内层紧实、外层舒展）
    float radialLayer = aRandom.y;
    float localSpread = smoothstep(
      0.0,
      1.0,
      clamp(uSpread * 1.25 - radialLayer * 0.25, 0.0, 1.0)
    );

    // 2. 在顶点着色器中插值：花苞位置 (position) -> 绽放位置 (aPositionBloom)
    vec3 pos = mix(position, aPositionBloom, localSpread);

    // 3. 绽放伴随旋转解旋效果：从含苞到盛开有柔和的螺旋展开感
    float twistAngle = (1.0 - localSpread) * (1.2 + radialLayer * 0.8);
    pos.xy = rotate2d(twistAngle) * pos.xy;

    // 4. 随时间整体缓慢自转与呼吸律动
    float slowRot = uTime * (0.12 + 0.08 * localSpread);
    pos.xy = rotate2d(slowRot) * pos.xy;

    float breath = sin(uTime * 2.2 + aRandom.x * 6.2831) * (0.03 + 0.06 * localSpread);
    pos += normalize(pos + vec3(0.0001)) * breath;

    // 5. 叠加手部中心位置偏移
    vec3 worldPos = pos + uFlowerCenter;

    // 6. 指尖微交互：计算粒子与 5 个指尖世界坐标的距离，产生轻柔的灵动扰动
    if (uHandActivity > 0.01) {
      for (int i = 0; i < 5; i++) {
        vec3 tipPos = uFingertips[i];
        vec3 diff = worldPos - tipPos;
        float dist = length(diff);
        float influenceRadius = 0.85;
        if (dist < influenceRadius && dist > 0.001) {
          float factor = pow(1.0 - dist / influenceRadius, 2.0) * uHandActivity;
          // 指尖附近的粒子向外轻推并向镜头方向微浮，形成触碰光波感
          worldPos += normalize(diff) * factor * 0.22;
          worldPos.z += factor * 0.18;
        }
      }
    }

    vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // 7. 粒子大小随绽放度与透视距离动态计算
    float sizeBoost = 0.75 + 0.55 * localSpread + 0.15 * sin(uTime * 3.0 + aRandom.x * 10.0);
    gl_PointSize = uBaseSize * aRandom.z * sizeBoost * uPixelRatio * (1.0 / -mvPosition.z);

    // 透明度随绽放微调
    vAlpha = 0.68 + 0.32 * localSpread;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uSpread;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    // 将方形点精灵裁剪为自带柔和光晕的发光圆点
    vec2 uv = gl_PointCoord - vec2(0.5);
    float dist = length(uv);
    if (dist > 0.5) discard;

    // 中心高光核 + 边缘指数衰减光晕
    float glow = pow(1.0 - dist * 2.0, 2.0);
    float core = smoothstep(0.18, 0.0, dist);

    // 绽放时色彩更加明亮通透
    vec3 finalColor = vColor * (1.0 + 0.35 * uSpread) + vec3(core * 0.55);

    gl_FragColor = vec4(finalColor, glow * vAlpha);
  }
`;

/**
 * ============================================================================
 * 五、 Three.js 场景与粒子花朵生成器
 * ============================================================================
 */
let scene, camera, renderer, clock;
let flowerPoints = null;
let flowerMaterial = null;

function initThreeScene() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.set(0, 0, 6.2);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance'
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  dom.webglContainer.appendChild(renderer.domElement);

  clock = new THREE.Clock();

  // 初始化着色器材质
  flowerMaterial = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uSpread: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uBaseSize: { value: CONFIG.basePointSize },
      uHandActivity: { value: 0.0 },
      uFlowerCenter: { value: new THREE.Vector3(0, 0, 0) },
      uFingertips: { value: STATE.fingertipsWorld }
    }
  });

  // 构建粒子花朵几何体
  buildFlowerParticles(CONFIG.particleCount, CONFIG.petalCount);

  window.addEventListener('resize', onWindowResize);
}

/**
 * 使用极坐标花瓣数学函数生成花苞态与绽放态双形态顶点数据
 * @param {number} count 粒子数量 (5000 ~ 20000)
 * @param {number} petalCount 花瓣阶数 k
 */
function buildFlowerParticles(count, petalCount) {
  if (flowerPoints) {
    scene.remove(flowerPoints);
    flowerPoints.geometry.dispose();
  }

  const geometry = new THREE.BufferGeometry();

  const positionsBud = new Float32Array(count * 3);
  const positionsBloom = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const randoms = new Float32Array(count * 3);

  // 定义多层渐变色彩：花蕊暖金 -> 内瓣玫粉 -> 外瓣仙紫 -> 瓣尖青蓝微光
  const colorStamen = new THREE.Color('#ffe066');
  const colorInnerPetal = new THREE.Color('#ff3385');
  const colorOuterPetal = new THREE.Color('#9d4edd');
  const colorTipGlow = new THREE.Color('#00f5d4');
  const tempColor = new THREE.Color();

  const goldenAngle = Math.PI * (3 - Math.sqrt(5)); // 黄金角分布保证粒子均匀不扎堆

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;

    // 归一化径向参数 u ∈ [0, 1]
    const u = Math.pow(i / count, 0.78);
    // 极角 theta
    const theta = i * goldenAngle;

    // 分层偏置，制造多层立体花冠（5 层花瓣错位）
    const layerIndex = i % 5;
    const layerPhase = (layerIndex * Math.PI) / petalCount * 0.5;

    // 极坐标花瓣轮廓函数：|cos(k * θ / 2)|^0.65 结合正弦波纹
    const rawPetal = Math.pow(Math.abs(Math.cos(petalCount * (theta + layerPhase) * 0.5)), 0.65);
    const harmonicRipple = 0.12 * Math.sin(petalCount * 2.0 * theta);
    const petalShape = 0.38 + 0.62 * rawPetal + harmonicRipple;

    // ------------------------------------------------------------------
    // 1. 计算【闭合花苞态】(position) —— 水滴形收拢球体
    // ------------------------------------------------------------------
    const budSin = Math.sin(u * Math.PI);
    const rBud = CONFIG.budRadius * budSin * (0.65 + 0.35 * rawPetal) + (Math.random() - 0.5) * 0.04;
    const twistBud = theta + u * 1.4;

    positionsBud[i3]     = rBud * Math.cos(twistBud);
    positionsBud[i3 + 1] = rBud * Math.sin(twistBud);
    // Z 轴前后收拢成花苞尖端
    positionsBud[i3 + 2] = (u - 0.45) * CONFIG.budRadius * 1.6 + Math.cos(u * Math.PI) * 0.15;

    // ------------------------------------------------------------------
    // 2. 计算【盛开绽放态】(aPositionBloom) —— 3D 碗状立体花冠
    // ------------------------------------------------------------------
    const isStamen = u < 0.14; // 前 14% 粒子作为中心花蕊
    let rBloom, zBloom;

    if (isStamen) {
      // 花蕊簇拥在花心并向镜头方向微凸
      const stamenU = u / 0.14;
      rBloom = CONFIG.flowerRadius * 0.22 * stamenU;
      zBloom = 0.35 * Math.cos(stamenU * Math.PI * 0.5) + (Math.random() - 0.5) * 0.08;
    } else {
      // 花瓣沿极坐标方程向外舒展，且随层级呈现碗状弧度
      const petalU = (u - 0.14) / 0.86;
      rBloom = CONFIG.flowerRadius * (0.16 + 0.84 * Math.pow(petalU, 0.85) * petalShape);
      rBloom += (Math.random() - 0.5) * 0.06;

      // 立体高度：内层向上捧起，外层花瓣尖端优雅后翻
      const cupCurve = Math.sin(petalU * Math.PI) * 0.65 - Math.pow(petalU, 2.2) * 0.55;
      const layerZOffset = (layerIndex - 2) * 0.07 * petalU;
      zBloom = cupCurve + layerZOffset + rawPetal * 0.18;
    }

    positionsBloom[i3]     = rBloom * Math.cos(theta);
    positionsBloom[i3 + 1] = rBloom * Math.sin(theta);
    positionsBloom[i3 + 2] = zBloom;

    // ------------------------------------------------------------------
    // 3. 计算【粒子渐变颜色】(aColor)
    // ------------------------------------------------------------------
    if (isStamen) {
      tempColor.copy(colorStamen).lerp(colorInnerPetal, u / 0.14 * 0.4);
    } else {
      const t = (u - 0.14) / 0.86;
      if (t < 0.55) {
        tempColor.copy(colorInnerPetal).lerp(colorOuterPetal, t / 0.55);
      } else {
        tempColor.copy(colorOuterPetal).lerp(colorTipGlow, (t - 0.55) / 0.45 * rawPetal);
      }
    }
    // 加入轻微亮度随机扰动，丰富星尘层次感
    const brightnessJitter = 0.88 + Math.random() * 0.28;
    colors[i3]     = Math.min(1.0, tempColor.r * brightnessJitter);
    colors[i3 + 1] = Math.min(1.0, tempColor.g * brightnessJitter);
    colors[i3 + 2] = Math.min(1.0, tempColor.b * brightnessJitter);

    // ------------------------------------------------------------------
    // 4. 附加随机属性 (aRandom)
    // ------------------------------------------------------------------
    randoms[i3]     = Math.random();                  // 随机相位
    randoms[i3 + 1] = u;                              // 径向层级 (0~1)
    randoms[i3 + 2] = 0.55 + Math.random() * 0.95;    // 粒子尺寸倍率
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positionsBud, 3));
  geometry.setAttribute('aPositionBloom', new THREE.BufferAttribute(positionsBloom, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aRandom', new THREE.BufferAttribute(randoms, 3));

  flowerPoints = new THREE.Points(geometry, flowerMaterial);
  scene.add(flowerPoints);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  flowerMaterial.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio, 2);

  dom.landmarkCanvas.width = window.innerWidth;
  dom.landmarkCanvas.height = window.innerHeight;
}

/**
 * ============================================================================
 * 六、 手势张开度 (Tension) 计算与 3D 坐标映射
 * ============================================================================
 */

/**
 * 计算两个 MediaPipe 3D 关键点之间的欧氏距离
 */
function dist3D(p1, p2) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  const dz = (p1.z || 0) - (p2.z || 0);
  return Math.hypot(dx, dy, dz);
}

/**
 * 根据手部 21 个关键点计算手掌张开度 tension ∈ [0, 1]
 * 公式：
 *   1. 分别计算食指(8)、中指(12)、无名指(16)、小指(20)指尖到手腕(0)的距离，
 *      除以对应掌指关节(5, 9, 13, 17)到手腕(0)的距离，得到尺度无关的伸展比值 R_fingers。
 *   2. 计算拇指尖(4)到小指根(17)的距离除以掌宽(5到17)，得到拇指张开比值 R_thumb。
 *   3. 加权平均后按 [ratioMin, ratioMax] 线性归一化并 clamp 到 [0, 1]。
 */
function computeHandTension(landmarks) {
  const wrist = landmarks[0];
  const fingerPairs = [
    { tip: 8, mcp: 5 },   // 食指
    { tip: 12, mcp: 9 },  // 中指
    { tip: 16, mcp: 13 }, // 无名指
    { tip: 20, mcp: 17 }  // 小指
  ];

  let sumRatio = 0;
  for (const pair of fingerPairs) {
    const tipDist = dist3D(landmarks[pair.tip], wrist);
    const mcpDist = Math.max(0.0001, dist3D(landmarks[pair.mcp], wrist));
    sumRatio += tipDist / mcpDist;
  }
  const fingersRatio = sumRatio / 4.0;

  // 拇指张开度考量
  const thumbSpan = dist3D(landmarks[4], landmarks[17]);
  const palmWidth = Math.max(0.0001, dist3D(landmarks[5], landmarks[17]));
  const thumbRatio = thumbSpan / palmWidth;

  const combinedRatio = 0.8 * fingersRatio + 0.2 * thumbRatio;

  // 归一化到 0 ~ 1
  const rawTension = (combinedRatio - CONFIG.ratioMin) / (CONFIG.ratioMax - CONFIG.ratioMin);
  return Math.max(0.0, Math.min(1.0, rawTension));
}

/**
 * 将 tension 映射为花朵目标绽放度 targetSpread：
 * - tension < 0.32 -> 0.0 (花苞闭合)
 * - tension > 0.66 -> 1.0 (完全绽放)
 * - 0.32 ~ 0.66 之间使用 smoothstep 平滑过渡
 */
function mapTensionToSpread(tension) {
  if (tension < CONFIG.budThreshold) {
    return 0.0;
  }
  if (tension > CONFIG.bloomThreshold) {
    return 1.0;
  }
  const t = (tension - CONFIG.budThreshold) / (CONFIG.bloomThreshold - CONFIG.budThreshold);
  return t * t * (3.0 - 2.0 * t); // 标准三次 Hermite 平滑插值
}

/**
 * 将 MediaPipe 归一化坐标 (x, y ∈ [0, 1]) 转换为 Three.js z=0 平面上的世界坐标
 * 注意：由于视频画面做了水平镜像 (scaleX(-1))，X 轴使用 (0.5 - landmark.x) 对齐
 */
function landmarkToWorld(landmark) {
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const visibleHeight = 2.0 * Math.tan(fovRad * 0.5) * camera.position.z;
  const visibleWidth = visibleHeight * camera.aspect;

  const worldX = (0.5 - landmark.x) * visibleWidth;
  const worldY = (0.5 - landmark.y) * visibleHeight;
  const worldZ = -landmark.z * 2.5;
  return new THREE.Vector3(worldX, worldY, worldZ);
}

/**
 * ============================================================================
 * 七、 MediaPipe Hands 初始化与摄像头视频流管理
 * ============================================================================
 */
let handsDetector = null;
let isProcessingFrame = false;
let cameraStream = null;

async function initMediaPipeAndCamera() {
  try {
    // 1. 初始化 MediaPipe Hands 实例
    const HandsConstructor = window.Hands;
    if (!HandsConstructor) {
      throw new Error('MediaPipe Hands 脚本加载失败，请检查网络连接。');
    }

    handsDetector = new HandsConstructor({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`
    });

    handsDetector.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.65,
      minTrackingConfidence: 0.65
    });

    handsDetector.onResults(onHandsResults);

    // 2. 请求摄像头权限并启动流
    await startWebcam();
  } catch (err) {
    handleCameraError(err);
  }
}

async function startWebcam() {
  dom.errorModal.classList.add('hidden');
  updateStatus('loading', '正在请求摄像头权限...');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('当前浏览器环境不支持 getUserMedia，请使用 localhost 或 HTTPS 访问。');
  }

  // 释放已有流
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
  }

  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'user',
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: false
  });

  dom.video.srcObject = cameraStream;
  await dom.video.play();

  dom.landmarkCanvas.width = window.innerWidth;
  dom.landmarkCanvas.height = window.innerHeight;

  updateStatus('ready', '摄像头已就绪 · 请将手掌置于镜头前（握拳闭合 / 张开绽放）');
  requestAnimationFrame(processVideoLoop);
}

async function processVideoLoop() {
  if (!CONFIG.manualMode && dom.video.readyState >= 2 && handsDetector && !isProcessingFrame) {
    isProcessingFrame = true;
    try {
      await handsDetector.send({ image: dom.video });
    } catch (e) {
      console.warn('MediaPipe 帧处理跳过:', e);
    }
    isProcessingFrame = false;
  }
  requestAnimationFrame(processVideoLoop);
}

/**
 * MediaPipe 识别结果回调
 */
function onHandsResults(results) {
  // 清空 2D 骨骼画布
  landmarkCtx.save();
  landmarkCtx.clearRect(0, 0, dom.landmarkCanvas.width, dom.landmarkCanvas.height);

  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    const landmarks = results.multiHandLandmarks[0];
    STATE.handDetected = true;

    // 1. 可选绘制 21 个手部关键点与连线
    if (CONFIG.showSkeleton) {
      if (window.drawConnectors && window.HAND_CONNECTIONS) {
        window.drawConnectors(landmarkCtx, landmarks, window.HAND_CONNECTIONS, {
          color: 'rgba(0, 242, 254, 0.65)',
          lineWidth: 2.5
        });
      }
      if (window.drawLandmarks) {
        window.drawLandmarks(landmarkCtx, landmarks, {
          color: '#ff4d94',
          fillColor: '#ffffff',
          lineWidth: 1,
          radius: 3.5
        });
      }
    }

    // 2. 计算平滑后的手掌张开度 tension
    const rawTension = computeHandTension(landmarks);
    STATE.tension += (rawTension - STATE.tension) * CONFIG.tensionSmoothing;

    // 3. 映射为花朵目标绽放度 targetSpread
    STATE.targetSpread = mapTensionToSpread(STATE.tension);

    // 4. 计算手部中心点（取中指根部 9 与食指尖 8 的加权位置，让花朵悬浮在掌心/指尖上方）
    const palmCenter = {
      x: landmarks[9].x * 0.65 + landmarks[8].x * 0.35,
      y: landmarks[9].y * 0.65 + landmarks[8].y * 0.35,
      z: landmarks[9].z
    };
    STATE.targetCenter.copy(landmarkToWorld(palmCenter));

    // 5. 更新 5 个指尖的 3D 世界坐标供顶点着色器交互使用
    const tipIndices = [4, 8, 12, 16, 20];
    for (let i = 0; i < 5; i++) {
      STATE.fingertipsWorld[i].copy(landmarkToWorld(landmarks[tipIndices[i]]));
    }
  } else {
    STATE.handDetected = false;
  }

  landmarkCtx.restore();
}

function handleCameraError(err) {
  console.error('摄像头初始化异常:', err);
  updateStatus('error', `摄像头未启用: ${err.message || '权限被拒绝或未找到设备'}`);
  dom.errorMessage.textContent = `错误详情：${err.name || 'Error'} - ${err.message || '无法调用摄像头设备'}`;
  dom.errorModal.classList.remove('hidden');
}

function updateStatus(type, message) {
  dom.statusDot.className = 'status-dot ' + type;
  dom.statusText.textContent = message;
}

/**
 * ============================================================================
 * 八、 UI 控件事件绑定与手动调试模式
 * ============================================================================
 */
function initUIEvents() {
  // 粒子数量动态调节 (5000 ~ 20000)
  dom.particleSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    CONFIG.particleCount = val;
    dom.particleVal.textContent = val;
    buildFlowerParticles(CONFIG.particleCount, CONFIG.petalCount);
  });

  // 花瓣阶数动态调节 (3 ~ 10)
  dom.petalSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    CONFIG.petalCount = val;
    dom.petalVal.textContent = val;
    buildFlowerParticles(CONFIG.particleCount, CONFIG.petalCount);
  });

  // 视频背景透明度调节
  dom.opacitySlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    dom.opacityVal.textContent = `${val}%`;
    dom.video.style.opacity = (val / 100).toFixed(2);
  });

  // 切换骨骼连线显示
  dom.toggleSkeleton.addEventListener('change', (e) => {
    CONFIG.showSkeleton = e.target.checked;
    if (!CONFIG.showSkeleton) {
      landmarkCtx.clearRect(0, 0, dom.landmarkCanvas.width, dom.landmarkCanvas.height);
    }
  });

  // 切换手动模拟模式
  dom.toggleManual.addEventListener('change', (e) => {
    enableManualMode(e.target.checked);
  });

  // 手动 Tension 滑块
  dom.manualSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    dom.manualVal.textContent = val.toFixed(2);
    if (CONFIG.manualMode) {
      STATE.tension = val;
      STATE.targetSpread = mapTensionToSpread(val);
    }
  });

  // 手动模式下鼠标/触摸移动跟随花朵位置
  window.addEventListener('pointermove', (e) => {
    if (!CONFIG.manualMode) return;
    const normX = 1.0 - e.clientX / window.innerWidth; // 与镜像坐标系保持一致
    const normY = e.clientY / window.innerHeight;
    const worldPos = landmarkToWorld({ x: normX, y: normY, z: 0 });
    STATE.targetCenter.copy(worldPos);
    STATE.fingertipsWorld[1].copy(worldPos);
  });

  // 错误弹窗按钮
  dom.retryCameraBtn.addEventListener('click', () => {
    startWebcam().catch(handleCameraError);
  });

  dom.useManualBtn.addEventListener('click', () => {
    dom.errorModal.classList.add('hidden');
    dom.toggleManual.checked = true;
    enableManualMode(true);
  });
}

function enableManualMode(enabled) {
  CONFIG.manualMode = enabled;
  if (enabled) {
    dom.manualWrapper.classList.remove('hidden');
    STATE.handDetected = true;
    STATE.tension = parseFloat(dom.manualSlider.value);
    STATE.targetSpread = mapTensionToSpread(STATE.tension);
    updateStatus('ready', '已开启手动模拟模式 · 拖动滑块控制绽放，移动鼠标带动花朵');
  } else {
    dom.manualWrapper.classList.add('hidden');
    STATE.handDetected = false;
    updateStatus('ready', '已切回摄像头手势识别模式');
  }
}

/**
 * 更新 HUD 仪表盘上的数值与状态徽章
 */
function updateHUD() {
  dom.tensionValue.textContent = STATE.tension.toFixed(2);
  dom.tensionBar.style.width = `${(STATE.tension * 100).toFixed(1)}%`;

  dom.spreadValue.textContent = STATE.currentSpread.toFixed(2);
  dom.spreadBar.style.width = `${(STATE.currentSpread * 100).toFixed(1)}%`;

  if (!STATE.handDetected && !CONFIG.manualMode) {
    dom.gestureBadge.textContent = '等待手部入画';
    dom.gestureBadge.className = 'badge';
  } else if (STATE.tension < CONFIG.budThreshold) {
    dom.gestureBadge.textContent = '✊ 握拳 · 花苞闭合';
    dom.gestureBadge.className = 'badge bud';
  } else if (STATE.tension > CONFIG.bloomThreshold) {
    dom.gestureBadge.textContent = '🖐️ 张开 · 花朵盛放';
    dom.gestureBadge.className = 'badge bloom';
  } else {
    dom.gestureBadge.textContent = '🌸 舒展 · 平滑过渡中';
    dom.gestureBadge.className = 'badge blooming';
  }
}

/**
 * ============================================================================
 * 九、 主渲染循环 (含核心缓动公式)
 * ============================================================================
 */
function animate() {
  requestAnimationFrame(animate);

  const elapsedTime = clock.getElapsedTime();

  // 若未检测到手部且非手动模式，让花朵缓慢回到屏幕中心并轻轻合拢为花苞
  if (!STATE.handDetected && !CONFIG.manualMode) {
    STATE.tension += (0.0 - STATE.tension) * 0.08;
    STATE.targetSpread = 0.0;
    STATE.targetCenter.set(0, 0, 0);
    STATE.handActivity += (0.0 - STATE.handActivity) * 0.08;
  } else {
    STATE.handActivity += (1.0 - STATE.handActivity) * 0.15;
  }

  // 【核心需求 5】使用指定缓动函数平滑更新绽放度
  STATE.currentSpread += (STATE.targetSpread - STATE.currentSpread) * CONFIG.spreadEasing;

  // 花朵整体 3D 位置平滑跟随手部中心
  STATE.currentCenter.lerp(STATE.targetCenter, CONFIG.positionLerp);

  // 花朵朝向随手部偏移产生轻微的 3D 视差倾斜，增强立体交互感
  if (flowerPoints) {
    flowerPoints.rotation.y = STATE.currentCenter.x * 0.18;
    flowerPoints.rotation.x = -STATE.currentCenter.y * 0.18;
  }

  // 更新 Shader Uniforms
  if (flowerMaterial) {
    flowerMaterial.uniforms.uTime.value = elapsedTime;
    flowerMaterial.uniforms.uSpread.value = STATE.currentSpread;
    flowerMaterial.uniforms.uHandActivity.value = STATE.handActivity;
    flowerMaterial.uniforms.uFlowerCenter.value.copy(STATE.currentCenter);
  }

  // 刷新 UI 指标面板并渲染 Three.js 场景
  updateHUD();
  renderer.render(scene, camera);
}

/**
 * ============================================================================
 * 十、 启动入口
 * ============================================================================
 */
function bootstrap() {
  initThreeScene();
  initUIEvents();
  initMediaPipeAndCamera();
  animate();
}

bootstrap();