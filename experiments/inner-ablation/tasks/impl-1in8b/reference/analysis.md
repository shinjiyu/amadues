# 1in8b.life 的实现

页面程序内联在 HTML 里，没有单独的外链脚本文件。语言由 window.LANG 决定，可选 en、ko、ja、zh、vi、fr。

界面用 document.createElement 画，不是 React 应用。页面里的 /api/react 是一个接口名字。

状态用 localStorage。同域接口包括 /api/home 和 /api/memorial。

响应头里 server 是 cloudflare，CSP 的 connect-src 只允许同源。
