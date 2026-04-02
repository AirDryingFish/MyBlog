---
title: "🐍 Python 学习笔记 #1：从零开始"
date: 2026-03-29
draft: true
tags:
    - Python
    - 编程
    - 入门
categories:
    - 技术学习
summary: Python 基础语法学习记录，变量、数据类型、条件判断 ✦
showtoc: true
---

## 为什么选择 Python？

Python 被称为最适合初学者的编程语言，因为：

- **语法简洁** — 读起来像自然语言
- **用途广泛** — 数据分析、AI、Web开发、自动化
- **社区庞大** — 遇到问题总能找到答案
- **库超级多** — 大部分功能不用从零写

## 今天学的内容

### 变量和数据类型

```python
# 字符串
name = "Yang"
greeting = f"你好，{name}！欢迎来到 Python 的世界"

# 数字
level = 1
exp = 0.0
is_learning = True

# 列表
skills = ["Hugo", "Markdown", "Git"]
skills.append("Python")  # 新技能 Get!

print(f"当前等级: Lv.{level}")
print(f"已学技能: {skills}")
```

### 条件判断

```python
exp = 85

if exp >= 100:
    print("🎉 升级了！")
    level += 1
elif exp >= 80:
    print("📈 快要升级了，加油！")
else:
    print("💪 继续积累经验值")
```

### 循环

```python
# 打印学习计划
study_plan = {
    "周一": "Python 基础",
    "周二": "数据结构",
    "周三": "算法入门",
    "周四": "项目实战",
    "周五": "复习总结",
}

for day, topic in study_plan.items():
    print(f"  {day}: {topic}")
```

## 今日总结

| 知识点 | 掌握程度 | 备注 |
|--------|---------|------|
| 变量赋值 | ⭐⭐⭐ | 很简单 |
| 数据类型 | ⭐⭐⭐ | 基本理解 |
| f-string | ⭐⭐⭐ | 超好用 |
| if/elif/else | ⭐⭐ | 需要多练 |
| for 循环 | ⭐⭐ | 需要多练 |

> 每天进步一点点，积少成多就是大进步！₍ᐢ..ᐢ₎

下一篇准备学**函数和模块**，敬请期待～
