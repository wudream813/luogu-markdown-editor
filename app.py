#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
洛谷 Markdown & KaTeX 实时预览编辑器 - Windows 桌面启动器
Luogu Markdown Editor Desktop Launcher
"""

import os
import sys
import webbrowser
import threading
import http.server
import socketserver

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class DualHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

def start_server(port):
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", port), DualHandler) as httpd:
        print(f"=======================================================")
        print(f" 洛谷 Markdown & KaTeX 编辑器服务已启动！")
        print(f" 本地访问地址: http://127.0.0.1:{port}")
        print(f" 局域网/预览地址: http://0.0.0.0:{port}")
        print(f" 按 Ctrl+C 可停止服务。")
        print(f"=======================================================")
        httpd.serve_forever()

def main():
    # Check if pywebview is available for native desktop window
    try:
        import webview
        # Start server in background thread
        server_thread = threading.Thread(target=start_server, args=(PORT,), daemon=True)
        server_thread.start()
        
        # Open native desktop window
        print("正在启动 Windows 原生桌面应用窗口...")
        webview.create_window(
            '洛谷 Markdown 编辑器 (KaTeX 实时预览)',
            f'http://127.0.0.1:{PORT}',
            width=1280,
            height=800,
            min_size=(800, 600)
        )
        webview.start()
    except (ImportError, Exception):
        # Fallback to local server + default browser
        server_thread = threading.Thread(target=start_server, args=(PORT,), daemon=True)
        server_thread.start()
        
        url = f'http://127.0.0.1:{PORT}'
        print(f"正在使用系统默认浏览器打开: {url}")
        webbrowser.open(url)
        
        try:
            server_thread.join()
        except KeyboardInterrupt:
            print("\n正在退出洛谷 Markdown 编辑器...")
            sys.exit(0)

if __name__ == '__main__':
    main()
