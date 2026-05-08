---
title: vulkan-engine-roadmap
description: ""
date: 2026-05-08T11:08:28.986Z
preview: ""
draft: true
tags: []
categories: []
---
# Vulkan 学习与图形引擎进阶路线

## 现状定位

完成 vulkan-tutorial 的 Loading Models 章节是一个分水岭。到这一步,Vulkan API 的核心套路(instance、device、swap chain、render pass、pipeline、descriptor、buffer/image、command buffer、同步原语)已经基本掌握。

接下来的路径分两段:**先把 vulkan-tutorial 剩余章节按需完成,然后从"会用 API"过渡到"会设计渲染器/引擎"**。

---

## 第一阶段: 完成 vulkan-tutorial 剩余章节

剩下的三章按重要性排序:

### Generating Mipmaps —— 必学

不只是为了"知道怎么生成 mipmap"。这一章让你第一次真正用 vulkan 在运行时**用 GPU 生成数据**(`vkCmdBlitImage` 在不同 mip 层级间逐级缩小)。这套"用 transfer/compute 在 image 上写东西"的模式后面到处都是: HDR bloom、SSAO 多分辨率模糊、间接光照辐照度图预计算。不做 mipmap 的话纹理远处会闪烁、走样,任何稍微像样的渲染器都不能省。

工作量: 半天到一天。

### Compute Shader —— 必学

PBR 渲染器、IBL 预计算、后处理(bloom、tonemapping、color grading)都需要 compute shader。光追也跟 compute pipeline 强相关。这章必修。

工作量: 一天。

### Multisampling —— 可以缓一缓

教 MSAA。MSAA 在前向渲染里有用,但实战中渲染器很可能走**延迟渲染**(deferred shading)路线,延迟渲染下 MSAA 性能开销巨大,通常用 TAA 替代。

不过这一章会讲**多采样 attachment 的 render pass 配置**,这个知识对以后做"渲染到 32-bit float HDR target"等离屏渲染有帮助。建议**快速读一遍代码,知道大概怎么做就行**,不一定全实现。

**推荐顺序**: Generating Mipmaps → Compute Shader,跳过或略读 Multisampling。

---

## 第二阶段: 从教程到引擎的能力跃迁

教程之后有一个明显的鸿沟: **教程让你学会画一个东西,但没教你怎么写一个能持续扩展的引擎架构**。这是大多数人卡住的地方。下面分四个台阶,每一阶都是一次能力跃迁。

### 阶段 1: 抽象与重构(2~4 周)

**目标**: 把教程的代码重构成能扩展的架构,而不是 main.cpp 里 2000 行。

具体任务:

- **资源管理类**: 包装 `VkBuffer + VkDeviceMemory` 成 RAII 的 `Buffer` 类,自动销毁。同样做 `Image`、`Texture`、`Pipeline`、`Shader` 等
- **VMA(Vulkan Memory Allocator)集成**: 用 AMD 开源的 vk-mem-alloc 替换手动 `vkAllocateMemory + vkBindMemory`。**这个非常重要**,手动管理 vulkan 内存在中等规模项目里就会爆炸,VMA 帮你做 sub-allocation、defragmentation、内存类型选择
- **descriptor 抽象**: 不要每个 pass 都手写 descriptor pool / set / layout / write,设计一个 `DescriptorBuilder` 类
- **command 缓冲管理**: 设计 per-frame command pool、跨帧同步、frames-in-flight 的统一管理
- **swap chain 重建机制**: 把窗口 resize 处理得干净

**核心资源**:

- **Vulkan Guide** (https://vkguide.dev) —— 接续 vulkan-tutorial 的网站,讲的就是从教程代码到真实引擎的过渡。**强烈推荐,基本必读**
- vkguide 后半部分讲 compute、indirect drawing、bindless 这些教程不教但实战必用的内容

### 阶段 2: 自由摄像机 + 场景管理(1~2 周)

**目标**: 能加载场景、控制摄像机、有像样的输入处理。

- **摄像机**: 实现 FPS 风格摄像机(WASD 移动 + 鼠标视角)和 orbit 摄像机(围绕模型旋转)。看似简单,但要处理 view/projection 矩阵、视锥剔除等细节
- **场景图(scene graph)**: 即使简单也要有,不然加载多个模型时一堆全局变量会疯掉。Entity-Component-System (ECS) 是常见架构,但前期可以先用最简单的层次树
- **GLTF 加载**: 抛弃 OBJ,改用 GLTF。GLTF 是行业标准,带材质、骨骼、动画、PBR 参数。用 [tinygltf](https://github.com/syoyo/tinygltf) 或 [cgltf](https://github.com/jkuhlmann/cgltf) 加载

做完这一步会有一个能"加载 GLTF 场景、用 WASD 在里面飞"的小程序。这是引擎的最小骨架。

### 阶段 3: PBR 渲染(2~4 周)

PBR 是个体系,不是单点知识。核心三块:

**3a. 材质模型**

Cook-Torrance BRDF + GGX 法线分布 + Smith 阴影遮蔽 + Schlick 菲涅尔近似。这是直接光照部分。

**3b. IBL(基于图像的光照)**

间接光部分。需要预计算两张东西:

- diffuse irradiance map(漫反射卷积)
- pre-filtered environment map(镜面反射,按粗糙度分级)
- BRDF LUT(GGX 积分查找表)

这些预计算用 compute shader 做(所以 compute shader 章节是先决条件)。

**3c. tonemapping + 后处理**

HDR → LDR 的色调映射,常用 ACES、Reinhard 等。

**学习资源**:

- **Real-Time Rendering 4th Edition** —— 行业 bible。第 9 章(Physically Based Shading)和第 10 章(Local Illumination)是 PBR 必读,做引擎期间会反复翻
- **LearnOpenGL 的 PBR 章节** —— https://learnopengl.com/PBR/Theory —— OpenGL 教程但理论部分通用,讲得很清楚。看完用 vulkan 实现一遍
- **Sascha Willems 的 vulkan 示例** —— https://github.com/SaschaWillems/Vulkan —— 这个仓库是 vulkan 学习圣物,几乎所有渲染技术的 vulkan 版本都有,包括 PBR、IBL、各种后处理。看他的代码学最快

做完这一阶段,你会有: 加载一个 GLTF PBR 模型、环境贴图反射、不同 metalness/roughness 的金属和电介质材质都正确显示。

### 阶段 4: 进阶渲染特性(按兴趣选)

到这一步已经有"自己的引擎"了。接下来的扩展看方向:

- **阴影**: cascaded shadow maps (CSM)、shadow filtering (PCSS、VSM)。引擎必备
- **延迟渲染**: G-buffer + lighting pass 架构。光源数量多时显著优于前向
- **后处理管线**: bloom、SSAO、SSR、TAA、motion blur、DOF。每个都是独立专题
- **全局光照**: GI 的实时近似——SDFGI、screen-space GI、voxel cone tracing 等
- **体积渲染**: 体积雾、云、粒子

vkguide.dev 后半部分讲了不少这些。Sascha Willems 的仓库每种都有示例。

---

## 第三阶段(可选): 光追

光追不是阶段 4 之后必跟的,但如果想引入,这里给路径。

### 学习前提

- 硬件支持光追(NVIDIA RTX、AMD RX 6000+ 等)
- vulkan 1.2+ 和 `VK_KHR_ray_tracing_pipeline` 扩展
- 对 acceleration structure(BVH 在 GPU 上的形态)有基础理解

### 学习路径

1. **NVIDIA Vulkan Ray Tracing Tutorial** —— https://nvpro-samples.github.io/vk_raytracing_tutorial_KHR/ —— NVIDIA 官方,从最基础的 ray query 到完整 ray tracing pipeline 都有,质量极高
2. **Sascha Willems 的 RT 示例** —— 仓库里几个 ray tracing 示例
3. 实现**混合渲染**: 光栅化做 primary visibility,光追做反射 / 阴影 / GI

光追单做大概 1~2 个月。如果要做"完全光追的渲染器"(path tracing),工程更大,涉及重要性采样、降噪等。

如果目标是游戏引擎而不是渲染研究,**hybrid 方式更实用**——大部分 AAA 游戏都是混合渲染。

---

## 引擎并行支线: 必备工具与基础设施

跟图形渲染没那么直接但引擎需要的几条线,可以并行推进:

### ImGui 集成

调试 GUI 必备。让你能实时调材质参数、相机参数、各种 toggle。Sascha Willems 的代码里有 imgui + vulkan 集成范例。

### 性能 profiling

- **RenderDoc** —— 图形 debug,免费跨平台
- **Nsight Graphics** —— NVIDIA 出品,功能更深
- **Tracy** —— CPU profiling

引擎一旦上规模,这些工具是续命的。

### Shader 工具链

手动 glslc 编译只够教程用。引擎需要自动化:

- 监听 shader 文件改动自动重编译
- shader 包含、宏定义、变体管理
- shader reflection(从 SPIR-V 读出 binding 信息,自动生成 descriptor 绑定)

参考 [shaderc](https://github.com/google/shaderc) 和 [SPIRV-Reflect](https://github.com/KhronosGroup/SPIRV-Reflect)。

### Asset 系统

资源加载、热重载、资源 ID 管理。中后期必加。

---

## 推荐时间线

### 短期(2~3 个月)

1. 完成 vulkan-tutorial 剩下的 mipmap 和 compute(跳过 multisampling 或简略读)
2. 跟着 vkguide.dev 重构代码,集成 VMA
3. 实现自由摄像机 + GLTF 加载,加 ImGui

### 中期(3~6 个月)

4. 完整 PBR + IBL 实现,这一阶段把 Real-Time Rendering 第 9~10 章吃透
5. 阴影 + 延迟渲染
6. 一组核心后处理(至少 bloom + tonemapping)

### 长期

7. 光追(混合渲染)
8. 编辑器、entity 系统、序列化(如果目标是完整引擎)

到中期已经足够当一个亮眼项目: 跑 PBR + 阴影 + 后处理 + GLTF 场景的自研 vulkan 引擎。光追加分,但不是必须。

---

## 反向建议: 几个容易走偏的地方

### 不要太早引入 ECS / 复杂架构

新手做引擎容易先花两周设计 ECS、scene graph、resource manager,最后渲染部分一行没动。**先用最简陋的架构跑通完整渲染管线**,再回头重构。

### 不要边学边换技术栈

vulkan 学到一半别看到 dx12、metal、wgpu 又心动。把 vulkan 一条路走完,这些都是大同小异的现代图形 API。

### 不要钻进 LOD / 流式加载这种工程坑

它们对引擎重要,但不是渲染技术。先把渲染搞好,这些工程问题等真实场景需要再加。

### 不要忽视 RenderDoc

每写一个新功能就用 RenderDoc 抓帧看结构,这比写 100 个 std::cout 都有用。早用早受益。

---

## 核心资源汇总

| 资源 | 用途 |
|------|------|
| https://vkguide.dev | vulkan-tutorial 之后的过渡,引擎架构重构 |
| https://github.com/SaschaWillems/Vulkan | 几乎所有渲染技术的 vulkan 实现参考 |
| https://learnopengl.com/PBR/Theory | PBR 理论入门(API 无关) |
| Real-Time Rendering 4th Ed. | 渲染领域 bible,长期参考书 |
| https://nvpro-samples.github.io/vk_raytracing_tutorial_KHR/ | 光追入门官方教程 |
| RenderDoc | 图形 debug 必备工具 |

---

**一句话总结**: 完成 mipmap + compute → vkguide → PBR/IBL → 阴影 + 延迟渲染——这是接下来 6 个月最值得走的路。光追放在这之后。Sascha Willems 仓库 + Real-Time Rendering + vkguide 三个资源够你打通完整链条。
