---
title: Vulkan-Texture Mapping
description: ""
date: 2026-04-10T06:41:00.152Z
preview: ""
draft: false
tags: []
categories: []
---


# Image
## Loding Image
使用stb加载图片，使用`vcpkg`管理外部包：`vcpkg install stb`。
然后修改MakeLists:
```
cmake_minimum_required(VERSION 3.20)
project(vulkan LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

find_package(Vulkan REQUIRED)
find_package(glfw3 CONFIG REQUIRED)
find_package(glm CONFIG REQUIRED)
find_package(Stb REQUIRED)  // Add this line

add_executable(vulkan main.cpp)

target_link_libraries(vulkan PRIVATE
    Vulkan::Vulkan
    glfw
    glm::glm
)
```
最后include即可使用：
```CPP
#define STB_IMAGE_IMPLEMENTATION
#include <stb_image.h>
```
