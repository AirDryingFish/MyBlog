---
title: Vulkan-uniform buffers
description: ""
date: 2026-04-03T17:13:29.335Z
preview: ""
draft: false
tags: []
categories:
    - vulkan
---

顶点属性(vertex buffer)是per-vertex的，每个顶点不同。但MVP矩阵是所有顶点共享的，每帧可能变化。如果塞进vertex buffer，即浪费内存又要频繁更新整个buffer。vulkan的解决方案是使用**descriptor**，一种让shader访问buffer/image等资源的机制。

<!-- Descriptor流程的步骤：
1. Descriptor Set Layout(pipeline创建时)：声明shader在binding 0处（GLSL里的`layout(binding = 0)`）需要一个uniform buffer。这就像函数签名，只说类型不说具体数据。类似render pass声明“需要一个color attachment”但不指定具体image view
```glsl
#version 450

layout(location = 0) in vec2 inPosition;
layout(location = 1) in vec3 inColor;
layout(location = 0) out vec3 fragColor;

layout(binding = 0) uniform UniformBufferObject
{
    mat4 model;
    mat4 view;
    mat4 proj;
} ubo;


void main() {
    gl_Position = vec4(inPosition, 0.0, 1.0);
    fragColor = inColor;
}
```

```cpp
void createDescriptorSetLayout()
{
    VkDescriptorSetLayoutBinding uboLayoutBinding{};
    uboLayoutBinding.binding = 0;
    uboLayoutBinding.descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
    // binding 0上只有1个descriptor
    uboLayoutBinding.descriptorCount = 1;
    // 只在顶点着色器中使用
    uboLayoutBinding.stageFlags = VK_SHADER_STAGE_VERTEX_BIT;
    uboLayoutBinding.pImmutableSamplers = nullptr;

    VkDescriptorSetLayoutCreateInfo layoutInfo{};
    layoutInfo.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
    layoutInfo.bindingCount = 1;
    layoutInfo.pBindings = &uboLayoutBinding;

    if (vkCreateDescriptorSetLayout(device, &layoutInfo, nullptr, &descriptorSetLayout) != VK_SUCCESS)
    {
        throw std::runtime_error("failed to create descriptor set layout!");
    }
}
```

2. Descriptor Set(从descriptor pool分配): 把一个实际的VkBuffer绑定到那个binding 0。类似framebuffer把具体的image view绑定到render pass声明的attachment上
```cpp


```


3. Bind Descriptor Set(录制command buffer时)：绘制前告诉GPU，用这个descriptor set，就像绑定vertex buffer和framebuffer一样 -->

## Vertex Shader
修改顶点着色器使其包含上述的descriptor对象：
```glsl
#version 450

layout(location = 0) in vec2 inPosition;
layout(location = 1) in vec3 inColor;
layout(location = 0) out vec3 fragColor;

layout(binding = 0) uniform UniformBufferObject
{
    mat4 model;
    mat4 view;
    mat4 proj;
} ubo;


void main() {
    gl_Position = vec4(inPosition, 0.0, 1.0);
    fragColor = inColor;
}
```

## Descriptor set layout
### C++侧的UBO定义
```cpp
struct UniformBufferObject {
    glm::mat4 model;
    glm::mat4 view;
    glm::mat4 proj;
};
```
glm的`mat4`和GLSL的`mat4`二进制兼容，后续可以直接memcpy到VkBuffer

### 创建流程

1. 描述每个binding
```cpp
VkDescriptorSetLayoutBinding uboLayoutBinding{};
uboLayoutBinding.binding = 0;           // 对应着色器 layout(binding = 0)
uboLayoutBinding.descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
uboLayoutBinding.descriptorCount = 1;   // 1个UBO，不是数组
uboLayoutBinding.stageFlags = VK_SHADER_STAGE_VERTEX_BIT; // 仅顶点着色器使用
uboLayoutBinding.pImmutableSamplers = nullptr; // 仅图像采样相关，这里不用
```

2. 打包成Layout对象
```cpp
VkDescriptorSetLayoutCreateInfo layoutInfo{};
layoutInfo.bindingCount = 1;
layoutInfo.pBindings = &uboLayoutBinding;
vkCreateDescriptorSetLayout(device, &layoutInfo, nullptr, &descriptorSetLayout);
```
如果着色器还需要纹理sampler等，就会有多个binding一起打包进这个layout。

3. 传入Pipeline Layout
```cpp
pipelineLayoutInfo.setLayoutCount = 1;
pipelineLayoutInfo.pSetLayouts = &descriptorSetLayout;
```
Pipeline编译时需要知道着色器期望的资源布局。可以指定多个descriptor set layout。

## Uniform buffer
上一步只是声明了接口，这一步开始创建实际存放UBO数据的buffer。

### 两个关键设计决策
1. 不用staging buffer
之前学vertex buffer时用了staging buffer(CPU可见->GPU专用)。但UBO每帧都要更新MVP矩阵，如果每帧都走staging->transfer流程反而更慢，所以直接用`HOST_VISIBLE | HOST_COHERENT`的内存，CPU直接写GPU直接读
2. 每个in-flight frame一个buffer
假设`MAX_FRAMES_IN_FLIGHT = 2`就创建2个uniform buffer。因为frame 0 的command buffer可能还在GPU上执行，此时CPU要为frame 1准备数据，要写buffer 1。但这时候如果只有1个uniform buffer，CPU写的时候GPU可能在读，会有读写不安全的问题。

### Persistent Mapping
```cpp
vkMapMemory(device, uniformBuffersMemory[i], 0, bufferSize, 0, &uniformBuffersMapped[i]);
```
只需要创建时map一次，拿到一个`*void`指针，之后每帧直接`memcpy`新数据到这个指针就行，不需要反复map/unmap。

整体思路是每帧通过`uniformBufferMapped[currentFrame]`直接`memcpy`新的MVP矩阵进去，零额外开销

## Updating Uniform buffer
接下来需要每帧更新uniform buffer。

1. 计算时间
```cpp
// static只会在第一次调用时初始化一次
static auto startTime = std::chrono::high_resolution_clock::now();
// 当前时间
auto currentTime = std::chrono::high_resolution_clock::now();
// 获取运行了多长时间
float time = std::chrono::duration<float, std::chrono::seconds::period>(currentTime - startTime).count();
```

2. 计算MVP矩阵

```cpp
UniformBufferObject ubo{};
// glm::mat4(1.0f) 返回单位矩阵；time * glm::radians(90.0f) 每秒旋转90°； glm::vec3(0.0f, 0.0f, 1.0f)绕 z轴 旋转
ubo.model = glm::rotate(glm::mat4(1.0f), time * glm::radians(90.0f), glm::vec3(0.0f, 0.0f, 1.0f));
// 摄像机在 (2,2,2) 位置看向原点 (0,0,0)，相当于从斜上方 45 度俯视
ubo.view = glm::lookAt(glm::vec3(2.0f, 2.0f, 2.0f), glm::vec3(0.0f, 0.0f, 0.0f), glm::vec3(0.0f, 0.0f, 1.0f));
// 透视投影，45 度垂直视场角，宽高比用 swap chain 当前尺寸算
ubo.proj = glm::perspective(glm::radians(45.0f), swapChainExtent.width / (float)swapChainExtent.height, 0.1f, 10.0f);
```
* Model: 让矩形绕Z轴旋转，`time * 90` 意味着每秒旋转90度。用chrono计时保证旋转速度不受帧率影响。
* View: 摄像机在`(2, 2, 2)`位置看向原点`(0, 0, 0)`，相当于从斜上方45度俯视。
* Projection: 透视投影，45度垂直视场角，宽高比用swap chain当前尺寸算

3. Y轴翻转
```cpp
ubo.proj[1][1] *= -1;
```
GLM是给OpenGL设计的，clip space中，OpenGL的Y轴朝上，Vulkan的Y轴朝下(左手系)，不翻转的话画面会上下颠倒

4. 写入buffer
```cpp
memcpy(uniformBufferMapped[currentFrame], &ubo, sizeof(ubo));
```
因为之前已经做了持久映射，这里直接 `memcpy` 就行。`currentImage` 对应当前 in-flight frame 的编号，确保写的是 GPU 当前没在读的那个 buffer。

## Descriptor Pool
上面update uniform buffer中，只是把MVP数据写入了`VkBuffer`，但是着色器还不知道去哪读这个buffer。

Descriptor Pool和command pool也是一样的模式：Descriptor set不能直接创建，要从Descriptor Pool分配。Descriptor Pool的作用是预先分配一块内存，后续从里面划分Descriptor Set，避免反复而小的内存分配。

### 创建Pool，并指定分配信息
```cpp
void createDescriptorPool()
{
    VkDescriptorPoolSize poolSize{};
    poolSize.type = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
    poolSize.descriptorCount = static_cast<uint32_t>(MAX_FRAMES_IN_FLIGHT);

    VkDescriptorPoolCreateInfo poolInfo{};
    poolInfo.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
    poolInfo.poolSizeCount = 1;
    poolInfo.pPoolSizes = &poolSize;
    poolInfo.maxSets = static_cast<uint32_t>(MAX_FRAMES_IN_FLIGHT);

    if (vkCreateDescriptorPool(device, &poolInfo, nullptr, &descriptorPool) != VK_SUCCESS)
    {
        throw std::runtime_error("failed to create descriptor pool!");
    }
}
```
* `poolSize.descriptorCount`: 池里有多少单个descriptor
* `poolInfo.maxSets`: 池里最多能分配多少个descriptor

### 分配Descriptor

#### 1. Allocate
利用之前定义创建的接口规格`descriptorSetLayout`，从descriptor pool中取出实际的descriptor set对象。
```cpp
std::vector<VkDescriptorSetLayout> layouts(MAX_FRAMES_IN_FLIGHT, descriptorSetLayout);
VkDescriptorSetAllocateInfo allocInfo{};
allocInfo.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
allocInfo.descriptorPool = descriptorPool;
allocInfo.descriptorSetCount = static_cast<uint32_t>(MAX_FRAMES_IN_FLIGHT);
allocInfo.pSetLayouts = layouts.data();

descriptorSets.resize(MAX_FRAMES_IN_FLIGHT);
if (vkAllocateDescriptorSets(device, &allocInfo, descriptorSets.data()) != VK_SUCCESS)
{
    throw std::runtime_error("failed to allocate descriptor sets!");
}
```
现在有了实例，但是里面的指针都是空的，就像`malloc`了一块内存但还没写入数据。

### 写入Descriptor
把具体的buffer地址填进去，告诉vulkan这个descriptor set的binding实际指向`uniformBuffers[i]`，从偏移0开始，大小是`sizeof(UniformBufferObject)`

```cpp
for (size_t i = 0; i < MAX_FRAMES_IN_FLIGHT; i++)
{
    VkDescriptorBufferInfo bufferInfo{};
    bufferInfo.buffer = uniformBuffers[i];
    bufferInfo.offset = 0;
    bufferInfo.range = sizeof(UniformBufferObject);

    VkWriteDescriptorSet descriptorWrite{};
    descriptorWrite.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
    descriptorWrite.dstSet = descriptorSets[i];
    // 写入binding 0上的descriptor
    descriptorWrite.dstBinding = 0;
    // descriptorWrite.dstArrayElement: 如果binding是一个数组，这个参数指定从数组的哪个元素开始写入。当前我们没有使用数组，所以设置为0。
    descriptorWrite.dstArrayElement = 0;

    descriptorWrite.descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
    descriptorWrite.descriptorCount = 1;

    descriptorWrite.pBufferInfo = &bufferInfo;
    descriptorWrite.pImageInfo = nullptr;       // Optional
    descriptorWrite.pTexelBufferView = nullptr; // Optional
    // vkUpdateDescriptorSets: 把我们填充好的descriptorWrite写入descriptor set中。
    // 这个函数可以一次写入多个descriptor set，所以它接受一个数组和一个计数参数。当前我们每次只写入一个descriptor set，所以设置为1。
    // vkUpdateDescriptorSets还有一个数组参数可以同时写入多个descriptor set，但我们当前不需要，所以设置为nullptr和0。
    vkUpdateDescriptorSets(device, 1, &descriptorWrite, 0, nullptr);
}
```

### 使用Descriptor
在`vkCmdDrawIndexed`之前使用`vkCmdBindDescriptorSets`进行
```cpp
// 绑定描述符集，告诉vulkan后续的绘制命令要使用哪个描述符集来获取shader需要的外部数据（比如uniform buffer）
vkCmdBindDescriptorSets(commandBuffer, VK_PIPELINE_BIND_POINT_GRAPHICS, pipelineLayout, 0, 1, &descriptorSets[currentFrame], 0, nullptr); 
```
* `commandBuffer`：把这条绑定命令录到哪个command buffer里
* `VK_PIPELINE_BIND_POINT_GRAPHICS`: 绑定到图形管线还是计算管线。descriptor set 是通用的，graphics 和 compute 管线都能用，所以要明确指定。

* `pipelineLayout`：告诉vulkan这些descriptor set对应哪个管线布局。因为pipeline layout定义了"set 0、set 1长什么样"，vulkan需要知道绑定的set应该要对号入座到哪个slot
* `firstset = 0`: 从第几号set slot开始绑定。shader里可以声明多组descriptor set:
```cpp
layout(set = 0, binding = 0) uniform UBO { ... };   // 全局数据
layout(set = 1, binding = 0) uniform sampler2D tex;  // 材质数据
```

* `descriptorSetCount = 1`: 这次绑定几个set。如果传2就是一次性绑定set 0和set 1。当前只有1个set所以传1

* `&descriptorSets[currentFrame]`: 实际要绑定的descriptor set数组。配合参数4和5，意思是"把`descriptorSets[currentFrame]绑定到set 0这个slot上`"

* `dynamicOffsetCount = 0 `: 动态偏移量的个数

* `pDynamicOffsets = nullptr`: 动态偏移量数组

参数7和8是给 VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC 用的。普通 uniform buffer 在 update 时就固定了 offset，而 dynamic 版本允许你在绑定时再指定偏移，这样一个大 buffer 里可以存多份数据，每次 draw call 通过不同 offset 切换。当前用的是普通 uniform buffer，不需要动态偏移，所以是 0 和 nullptr。

#### **Y 翻转导致正面方向反转**
上面在`updateUniformBuffer`做了这一行：
```cpp
ubo.proj[1][1] *= -1;
```
这是因为vulkan的NDC Y轴朝下，而GLM是为OpenGL Y轴朝上设计的，所以需要翻转Y。
但是翻转Y有个副作用，它改变了坐标系的手性：原本顶点按照顺时针排列的三角形，Y翻转后从GPU视角看变成了逆时针。而光栅化设置是：
```cpp
rasterizerInfo.cullMode = VK_CULL_MODE_BACK_BIT;
rasterizerInfo.frontFace = VK_FRONT_FACE_CLOCKWISE;  // 顺时针=正面
```
GPU会认为顺时针是正面，逆时针是背面。翻转Y后所有三角形都变成逆时针了，全被当背面剔除掉，什么都看不见。修复方法就是把正面定义改成逆时针：
```cpp
rasterizerInfo.frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE;
```

![result](/images/QQ20260404-011133.gif)


## 内存对齐要求
CPU端的C++结构体内存布局和GPU端shader的uniform block内存布局必须完全一致，否则GPU读取到的数据就是错的。
### 问题起因
GPU的uniform buffer遵循一套严格的对齐规则(称为std140布局)，其中关键的几条是：**`mat4`必须从16的倍数地址开始**，**`vec2`必须从8的倍数地址开始**。
当结构体只有三个`mat4`时，一切正常：
```
偏移 0:   model  (64字节)   ← 0 是 16 的倍数 ✓
偏移 64:  view   (64字节)   ← 64 是 16 的倍数 ✓
偏移 128: proj   (64字节)   ← 128 是 16 的倍数 ✓
```

但如果在前面加一个`vec2 foo`(8字节)，C++的默认布局就变成：
```
偏移 0:   foo    (8字节)
偏移 8:   model  (64字节)   ← GPU 期望 16 的倍数，但这里是 8 ✗
偏移 72:  view   (64字节)   ← GPU 期望 16 的倍数，但这里是 72 ✗
偏移 136: proj   (64字节)   ← 136 也不是 16 的倍数 ✗
```
C++ 编译器按自己的规则排列成员（`vec2` 只需 8 字节对齐），但 GPU 按 std140 规则要求 `mat4` 必须 16 字节对齐。两边规则不同，布局就对不上了。GPU 从偏移 16 开始读 `model`，但 C++ 实际把 model 放在了偏移 8，数据全乱了。

### 修复方式
用 `alignas(16)` 强制 C++ 编译器把 `model` 的起始地址对齐到 16：
```cpp
struct UniformBufferObject {
    glm::vec2 foo;
    alignas(16) glm::mat4 model;  // 强制从 16 的倍数开始
    glm::mat4 view;
    glm::mat4 proj;
};
```
这样 foo 占 8 字节，编译器填充 8 字节 padding，`model` 从偏移 16 开始，后面就都对齐了。

或者使用`GLM_FORCE_DEFAULT_ALIGNED_GENTYPES`。这个宏让 GLM 的 `vec2`、`mat4` 等类型自带 `alignas(16)` 属性，这样大多数情况下不用手动写 alignas。但它有盲区——对于嵌套结构体，C++ 编译器不知道 GPU 要求嵌套结构按 16 字节对齐，所以仍然需要手动加 `alignas(16)`。

因此最终建议方式，给每个成员都显式加`alignas(16)`:
```cpp
struct UniformBufferObject {
    alignas(16) glm::mat4 model;
    alignas(16) glm::mat4 view;
    alignas(16) glm::mat4 proj;
};
```


## 多descriptor sets
理解set和biding：
```
[卡片 set 0]                    [卡片 set 1]
┌─────────────────────┐         ┌─────────────────────┐
│ binding 0: view/proj│          │ binding 0: model    │
│ binding 1: 环境贴图   │         └─────────────────────┘
│ binding 2: 阴影贴图   │
└─────────────────────┘
```
set 是一张卡片，binding 是卡片上的印刷栏位。卡片是一次性印好的，你没法只擦掉其中一栏重写——要换任何一栏的内容，就得换一整张卡片。
set 是最小的绑定/切换粒度。你没法单独换 set 里的一个 binding，只能整个 set 换掉。分多个 set 的好处是让你能只换需要换的那个 set，不动其他的。

假设有一个场景：100个物体，它们共享一个摄像机(view&proj矩阵)，但每个物体都有自己的model矩阵

### 不分组的做法(单个descriptor set)
每个物体一个descriptor set，里面同时包含view/proj和model：
```glsl
layout(set = 0, binding = 0) uniform GlobalUBO { mat4 view; mat4 proj; };
layout(set = 0, binding = 1) uniform ObjectUBO { mat4 model; };
```
画100个物体，每次draw call前都要重新绑定整个set 0。即使vew/proj没变。因为它们都在同一张“卡片”上，model不同，就要有100张卡片set。

### 分组的做法(多个descriptor set)
把不变的和变化的拆到不同 set：
```glsl
layout(set = 0, binding = 0) uniform GlobalUBO { mat4 view; mat4 proj; };  // 全场景共享
layout(set = 1, binding = 0) uniform ObjectUBO { mat4 model; };            // 每物体不同
```
渲染循环就变成：
```cpp
// 绑定 set 0 —— 整帧只需一次
vkCmdBindDescriptorSets(..., 0, 1, &globalSet, ...);

for (每个物体) {
    // 只重新绑定 set 1 —— set 0 不动
    vkCmdBindDescriptorSets(..., 1, 1, &objectSets[i], ...);
    vkCmdDrawIndexed(...);
}
```
注意 `firstSet = 1` 表示"从 set 1 开始绑定，set 0 保持不动"。这就是之前解释 `vkCmdBindDescriptorSets` 参数时 `firstSet` 的用途。

### 为什么更高效
绑定descriptor set不是免费的，驱动需要验证、更新GPU状态。如果100次draw call每次都绑定全部数据，很多工作是重复的。拆分后，不变的数据只绑定一次，每次 draw call 只更新真正变化的那部分，减少了驱动开销。

* 单set不分组
```
bind set0_物体A → draw A
bind set0_物体B → draw B
bind set0_物体C → draw C
...
```
总共 100 次 bind


* 多set分组
```
bind set0 (view/proj) → 1次
bind set1_物体A → draw A
bind set1_物体B → draw B
bind set1_物体C → draw C
...
```
总共 1 + 100 = 101 次 bind


表面上多个descriptor set的策略还多了一次bind。但关键区别是每次 bind 的东西变小了。不分组时每次 bind 的 set 里有 view/proj + 环境贴图 + 阴影贴图 + model，是一张大卡片。分组后频繁 bind 的 set 1 里只有一个 model，是一张小卡片。驱动验证和更新的工作量跟 set 里 binding 的数量相关，小卡片处理起来更快。所以优化的本质不是减少 bind 次数，而是减少每次 bind 的工作量。

这也是为什么实际游戏引擎里常见的分组策略是按更新频率划分：set 0 放全局数据（每帧一次），set 1 放材质数据（每材质一次），set 2 放物体数据（每 draw call 一次）。