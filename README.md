# 🌸 指尖生花 · Gesture Blooming Flower

> **MediaPipe Hands × Three.js WebGL 粒子花朵手势交互艺术**  
> 一款纯前端无服务器、基于视觉手势驱动的 3D 粒子交互实验。摄像头实时追踪手部 21 个骨骼关键点，计算手掌张弛度（Tension），驱动指尖粒子花朵聚拢闭合与盛大绽放。

[![GitHub Pages](https://img.shields.io/badge/Demo-GitHub%20Pages-ff5f9e?style=for-the-badge&logo=github)](https://sukikeeling.github.io/gesture-blooming-flower/)
[![Three.js](https://img.shields.io/badge/Three.js-r160-black?style=for-the-badge&logo=threedotjs)](https://threejs.org/)
[![MediaPipe](https://img.shields.io/badge/MediaPipe-Hands-009688?style=for-the-badge&logo=google)](https://developers.google.com/mediapipe)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](./LICENSE)

---

## 🌟 在线体验 (Live Demo)

👉 **立即体验**：[https://sukikeeling.github.io/gesture-blooming-flower/](https://sukikeeling.github.io/gesture-blooming-flower/)

*(注：建议在 PC 端使用 Chrome / Edge 浏览器并授予摄像头权限，所有图像计算均在浏览器本地通过 WebAssembly / WebGL 进行，绝不上报或存储任何画面。)*

---

## ✨ 核心特性

- **🖐️ 实时手势骨骼解算**：基于 Google MediaPipe Hands 极速解算手部 21 个 3D 关键点，平滑追踪食指指尖与掌心锚点。
- **🌸 粒子动态花朵模拟**：8,000+ 动态 GPU 粒子系统，基于球坐标与玫瑰曲线公式，模拟花苞紧闭、微张、盛放与呼吸动态。
- **⚡ 张力平滑自适应驱动**：实时计算手掌张开度张力标尺（Tension），配合阻尼缓动插值，实现跟手动效丝滑连贯。
- **🎨 艺术配色预设与调控**：
  - **樱粉花海 (Sakura)**：暮色渐变、玫瑰粉与金黄花蕊
  - **极光流彩 (Aurora)**：青金与紫罗兰流转极光
  - **向日暖阳 (Sunflower)**：温暖明丽的金葵原野
- **🎛️ 现代毛玻璃 HUD 交互面板**：
  - 手势张开度与闭合/盛放状态指示灯
  - 粒子密度切换（4,000 / 8,000 / 16,000）
  - 追踪锚点切换（食指指尖 / 掌心）
  - 骨骼连线与摄像头透视开关
  - 实时渲染与视觉帧率监测

---

## 🎮 交互手势说明

| 手势动作 | 状态判定 | 花朵形态反应 |
| :--- | :--- | :--- |
| **✊ 紧握拳头** | `Tension < 0.32` | 花苞聚拢闭合、含苞待放 |
| **✋ 张开手掌** | `Tension > 0.66` | 粒子花瓣在指尖盛大绽放、随风轻摆 |
| **🤏 掌指微张** | `0.32 ~ 0.66` | 动态插值缓动舒展 |
| **👉 食指移动** | 空间位移 | 粒子花朵如影随形，悬浮于指尖 |

---

## 🚀 本地运行

纯静态项目，零构建依赖，直接使用任意静态服务器打开即可：

```bash
# 克隆仓库
git clone https://github.com/sukikeeling/gesture-blooming-flower.git
cd gesture-blooming-flower

# 启动本地开发服务 (推荐使用 Python 或 npx serve)
python -m http.server 8080
# 或
npx serve .
```

在浏览器打开 `http://localhost:8080` 并允许摄像头权限即可体验。

---

## 📜 许可证 (License)

本项目采用 [MIT License](./LICENSE) 开源协议。
