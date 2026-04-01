# ✦ 个人笔记仓库 ✦

基于 Hugo + PaperMod 主题搭建，托管在 Cloudflare Pages。

## 快速开始

```bash
# 克隆（包含子模块）
git clone --recursive https://github.com/your-username/my-blog.git

# 本地预览
cd my-blog
hugo server -D
```

打开 http://localhost:1313

## 新建文章

```bash
hugo new posts/my-new-post.md
```

## 部署

推送到 GitHub 后，Cloudflare Pages 会自动构建部署。

## 自定义

- 修改配置：编辑 `hugo.toml`
- 修改主题样式：编辑 `assets/css/extended/anime-theme.css`
- 添加图片：放到 `static/images/` 目录
