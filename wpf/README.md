# 墨读 InkRead — WPF 桌面版（M4 交付）

本目录将存放 **WPF + WebView2 桌面壳**，复用 `../web/` 的全部前端代码。

## 架构

```
wpf/
  InkRead.sln / InkRead.csproj     WPF 工程（.NET 8, net8.0-windows）
  MainWindow.xaml                  主窗口：无边框窗体 + WebView2 控件
  wwwroot -> ../web/*              构建时拷贝 web 前端（或虚拟主机映射）
```

## 要点（实现时遵守）

1. WebView2 加载本地前端，`CoreWebView2` 用虚拟主机映射（SetVirtualHostNameToFolderMapping）
   把 `https://app.inkread/` 映射到 `wwwroot/`，规避 file:// 的 worker/存储限制。
2. TTS（speechSynthesis）、IndexedDB 在 WebView2 内全部可用；用户数据目录放在
   `%LOCALAPPDATA%\InkRead\WebView2`，升级不丢词库。
3. 原生增强（后续可选）：文件关联（.epub/.mobi 直接打开）、系统右键菜单、全局快捷键、
   托盘图标。加原生功能时通过 `window.chrome.webview.postMessage` 与前端通信，
   并同步更新 `../THEMES.md` 的界面结构说明。

## 状态

- [x] 目录规划（本次）
- [ ] M4：WPF 壳工程 + 打包发布（exe）
