---
title: Vulkan-vertex buffers
description: ""
date: 2026-04-01T03:21:30.821Z
preview: ""
draft: false
tags:
    - Vulkan
categories:
    - Vulkan
math: true
---

## Staging Buffer 暂存缓冲区

之前的方案是直接在CPU可访问的内存上创建顶点缓冲区，没有使用staging buffer。`createVertexBuffer()`中：
1. 创建一个`VK_BUFFER_USAGE_VERTEX_BUFFER_BIT`的buffer
2. 分配内存时请求的是`VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT`，也就是CPU可见、自动同步的内存
3. 然后直接`vkMapMemory->memcpy->vkUnmapMemory`，手动将顶点数据从CPU端拷贝进去

这个方案能正常工作，但是HOST_VISIBLE的内存在独显上通常位于RAM或者PCIe BAR区域。虽然memcpy只在初始化时执行一次，但数据一直"住"在系统内存中，GPU每帧渲染读取顶点数据时都要通过PCIe总线去访问。而staging buffer方案是初始化时多一次GPU拷贝，把数据搬到DEVICE_LOCAL显存里，之后每帧GPU直接从本地显存高速读取。


### Transfer queue 转运队列

`vkCmdCopyBuffer`这样的传输命令需要队列支持`VK_QUEUE_TRANSFER_BIT`。现在已经在使用的**Graphics**队列族天生就支持传输操作。简单做法是直接用现有的**Graphics**队列来提交拷贝命令，不需要改任何队列相关的代码。
进阶做法是用一个专门的**Transfer**队列族来拷贝，某些显卡上存在专门的**Transfer**队列族，制作数据搬运不做图形渲染，GPU可以并行工作：Transfer队列搬运数据的同时，Graphics队列继续渲染，互不阻塞。
1. `findQueueFamilies`要额外找一个只有`TRANSFER_BIT`没有`GRAPHICS_BIT`的队列族，这样能找到专用的传输队列，而不是“顺便能传输”的队列
2. `createLogicalDevice`要多请求一个传输队列的handle
3. 要创建第二个Command Pool，因为Command Pool和队列族绑定，不同队列族需要不同的Pool
4. buffer的`sharingMode`要改成`CONCURRENT`。因为现在两个不同的队列族都要访问同一个buffer（Transfer队列写入，Graphics队列读取）
5. 拷贝命令提交到Transfer队列而不是Graphics队列

### Abstracting buffer creation 抽象缓冲区创建
如果每次都把“创建Buffer->查询内存需求->分配内存->绑定”这套代码写一遍会有大量重复，把通用逻辑抽成一个`createBuffer`函数：

```cpp
void createBuffer(VkDeviceSize size, VkBufferUsageFlags usage, VkMemoryPropertyFlags properties, VkBuffer& buffer, VkDeviceMemory& bufferMemory)
{

    VkBufferCreateInfo bufferInfo{};
    bufferInfo.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
    bufferInfo.size = size;
    bufferInfo.usage = usage; // 这个buffer是用来当顶点缓冲区的
    // 缓冲区可以由特定队列族所有，或者在多个队列族之间共享。
    // 顶点缓冲区只会从图形队列中使用，因此可以使用EXCLUSIVE模式。只有当不同队列族需要访问同一个缓冲区时，才需要使用CONCURRENT模式，并且还需要指定所有访问该缓冲区的队列族索引。
    bufferInfo.sharingMode = VK_SHARING_MODE_EXCLUSIVE;

    if (vkCreateBuffer(device, &bufferInfo, nullptr, &buffer) != VK_SUCCESS)
    {
        throw std::runtime_error("failed to create vertex buffer!");
    }

    // 分配内存
    // step 1: 查询缓冲区需要什么样的内存。
    // memRequirements告诉三件事：
    // 1. size: 需要分配的内存大小(字节数)。这个值可能会根据buffer的usage和format等属性而变化。
    // 2. alignment: 内存的对齐要求。分配的内存地址必须是alignment的倍数。这个值可能会根据buffer的usage和format等属性而变化。
    // 3. memoryTypeBits: 一个位掩码，表示哪些类型的内存可以用来分配这个buffer。每个位对应一个内存类型，如果某个位为1，表示该内存类型支持这个buffer的需求。这个值取决于buffer的usage和format等属性，以及物理设备的内存特性。
    VkMemoryRequirements memRequirements;
    vkGetBufferMemoryRequirements(device, buffer, &memRequirements);

    VkMemoryAllocateInfo allocInfo{};
    allocInfo.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
    allocInfo.allocationSize = memRequirements.size;
    // step 2: 根据第一步查询到的内存需求，找到一个既满足buffer需求又具有指定属性的内存类型。比如我们需要一个既能当作顶点缓冲区又可以直接从CPU访问的内存类型。
    // HOST_VISIBLE + HOST_COHERENT: CPU可写，且自动同步
    allocInfo.memoryTypeIndex = findMemoryType(memRequirements.memoryTypeBits, properties);

    if (vkAllocateMemory(device, &allocInfo, nullptr, &bufferMemory) != VK_SUCCESS)
    {
        throw std::runtime_error("failed to allocate vertex buffer memory!");
    }
    vkBindBufferMemory(device, buffer, bufferMemory, 0);
}

```

### Using a staging buffer 使用暂存缓冲区
#### - 改造`createVertexBuffer`
现在创建两个buffer而不是一个：
* stagingBuffer: `TRANSFER_SRC_BIT`+`HOST_BISIBLE`，意思是“我是数据搬运的源头，CPU可以往我身上写”。CPU把顶点数据memcpy进来
* vertexBuffer: `RANSFER_DST_BIT | VERTEX_BUFFER_BIT`+`DEVICE_LOCAL`。意思是“我是搬运的目的地，同时也是顶点缓冲区，在显卡本地显存里”。CPU不能直接写，只能通过GPU拷贝命令搬数据。

```cpp
void createVertexBuffer()
{
    VkDeviceSize bufferSize = sizeof(vertices[0]) * vertices.size();
    VkBuffer stagingBuffer;
    VkDeviceMemory stagingBufferMemory;
    createBuffer(bufferSize, VK_BUFFER_USAGE_TRANSFER_SRC_BIT, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT, stagingBuffer, stagingBufferMemory);
    void *data;
    // vkMapMemory: 把一段GPU端的内容映射到CPU端的指针data
    vkMapMemory(device, vertexBufferMemory, 0, bufferSize, 0, &data);
    // 把顶点数据拷贝到映射区data
    memcpy(data, vertices.data(), (size_t)bufferSize);
    vkUnmapMemory(device, vertexBufferMemory);

    createBuffer(bufferSize, VK_BUFFER_USAGE_TRANSFER_DST_BIT | VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, vertexBuffer, vertexBufferMemory);
}

```

#### - `copyBuffer`函数——用GPU命令搬数据
之前使用的`vkMapMemory`的本质是把一段GPU内存映射到CPU的虚拟地址空间，让CPU能像读写普通变量一样访问。但是这要求CPU本身对那块内存物理可达，比如位于RAM或PCIe BAR区域。

`DEVICE_LOCAL`的显存没有暴露给CPU的地址映射，CPU没有合法的指针能访问那块内存，所以`vkMapMemory`会失败，数据只能通过GPU自己的拷贝命令`vkCmdCopyBuffer`搬进去。
流程是：
1. 从command Pool分配一个临时的command buffer
```cpp
VkCommandBufferAllocateInfo allocInfo{};
allocInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
allocInfo.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
allocInfo.commandPool = commandPool;
allocInfo.commandBufferCount = 1;

VkCommandBuffer commandBuffer;
vkAllocateCommandBuffers(device, &allocInfo, &commandBuffer);

```
2. 开始录制，标记为`ONE_TIME_SUBMIT`：只用一次，驱动可以优化
```cpp
VkCommandBufferBeginInfo beginInfo{};
beginInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
beginInfo.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;

vkBeginCommandBuffer(commandBuffer, &beginInfo);
```

3. 录入一条`vkCmdCopyBuffer`命令，指定从src拷贝到dst，拷贝多大
```cpp
VkBufferCopy copyRegion{};
copyRegion.srcOffset = 0; // Optional
copyRegion.dstOffset = 0; // Optional
copyRegion.size = size;
vkCmdCopyBuffer(commandBuffer, srcBuffer, dstBuffer, 1, &copyRegion);
```


4. 结束录制


```cpp
vkEndCommandBuffer(commandBuffer);
```
5. 提交到graphicsQueue执行
```cpp
VkSubmitInfo submitInfo{};
submitInfo.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
submitInfo.commandBufferCount = 1;
submitInfo.pCommandBuffers = &commandBuffer;
vkQueueSubmit(graphicsQueue, 1, &submitInfo, VK_NULL_HANDLE);
```

6. `vkQueueWaitIdle`等他执行完
```cpp
vkQueueWaitIdle(graphicsQueue);
```

7. 释放这个临时command buffer

```cpp
vkFreeCommandBuffers(device, commandPool, 1, &commandBuffer);
```

#### - 清理staging buffer
拷贝完成后，staging buffer的使命就结束了，立刻销毁释放内存。最终只有`DEVICE_LOCAL`的vertex buffer留下来供后续使用。
```cpp
void createVertexBuffer()
{
    VkDeviceSize bufferSize = sizeof(vertices[0]) * vertices.size();
    VkBuffer stagingBuffer;
    VkDeviceMemory stagingBufferMemory;
    createBuffer(bufferSize, VK_BUFFER_USAGE_TRANSFER_SRC_BIT, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT, stagingBuffer, stagingBufferMemory);

    void *data;
    // vkMapMemory: 把一段GPU端的内容映射到CPU端的指针data
    vkMapMemory(device, stagingBufferMemory, 0, bufferSize, 0, &data);
    // 把顶点数据拷贝到映射区data
    memcpy(data, vertices.data(), (size_t)bufferSize);
    vkUnmapMemory(device, stagingBufferMemory);

    createBuffer(bufferSize, VK_BUFFER_USAGE_TRANSFER_DST_BIT | VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, vertexBuffer, vertexBufferMemory);

    copyBuffer(stagingBuffer, vertexBuffer, bufferSize);
    vkDestroyBuffer(device, stagingBuffer, nullptr);
    vkFreeMemory(device, stagingBufferMemory, nullptr);
}
```

## Index Buffer 索引缓冲区
Index Buffer解决的是***顶点数据重复***的问题。用矩形来理解，一个矩形有4个顶点，但GPU只认三角形，因此得把矩形拆分为2个三角形来画。

* 没有Index Buffer的时候，Vertex Buffer要存6个顶点：
```
三角形1: V0, V1, V2
三角形2: V2, V1, V3

Vertex Buffer: [V0, V1, V2, V2, V1, V3]  // 6个顶点

```
其中$V1$、$V2$存了两边。对于矩阵这只是多了2个顶点，但是每个顶点可能包含位置(`vec3`)、法线(`vec2`)、UV(`vec2`)、切线(`vec4`)等数据，加起来可能有48字节甚至更多。

* 加入Index Buffer后：
Vertex只存4个不重复的顶点，然后用一个整数数组(Index Buffer)来告诉GPU"按什么顺序来组装三角形"：
```
Vertex Buffer: [V0, V1, V2, V3]  // 4个顶点，无重复
Index Buffer:  [0, 1, 2, 2, 1, 3] // 6个索引，每个索引就是一个整数
```
GPU画第一个三角形时，去Vertex Buffer里去0、1、2号顶点；画第二个三角形时，取2、1、3号顶点。顶点没有重复，只是多了6个整数(`uint_16`或者`uint_32`，2~4字节)的开销。

### 创建流程
`createIndexBuffer`的逻辑和`createVertexBuffer`走的是同一套 staging buffer 模式：
1. 在 CPU 可见的内存上创建一个临时的 staging buffer (`HOST_VISIBLE`)，把 `indices` 数组通过 `memcpy` 写进去。这块内存 CPU 能直接访问，但 GPU 读取它速度慢
2. 在 GPU 本地显存上创建正式的 index buffer (`DEVICE_LOCAL`)。这块内存 GPU 读取极快，但 CPU 不能直接写。
3. 用 `copyBuffer` 发一条 GPU命令，把数据从 staging buffer 拷贝到 devicel local 的 index buffer。
4. 销毁 staging buffer