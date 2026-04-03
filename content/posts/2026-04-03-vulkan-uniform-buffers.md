---
title: Vulkan-uniform buffers
description: ""
date: 2026-04-03T08:18:41.804Z
preview: ""
draft: false
tags: []
categories: []
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
 
