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

import socket
import contextlib

PORT = 8080
# Bind to loopback only. Binding 0.0.0.0 exposed every local draft to anyone on the
# same network (coffee-shop / dorm / school WiFi) with no authentication at all.
HOST = '127.0.0.1'
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class DualHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

def find_free_port(preferred, host=HOST, attempts=20):
    """Return the first bindable port at or after `preferred`.

    Previously a busy port 8080 crashed the launcher outright with EADDRINUSE.
    """
    for offset in range(attempts):
        candidate = preferred + offset
        with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, candidate))
                return candidate
            except OSError:
                continue
    raise RuntimeError(
        f"{preferred}-{preferred + attempts - 1} 端口均被占用，请关闭占用程序后重试。"
    )


def start_server(port):
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((HOST, port), DualHandler) as httpd:
        print("=======================================================")
        print(" 洛谷 Markdown & KaTeX 编辑器服务已启动！")
        print(f" 本地访问地址: http://{HOST}:{port}")
        print(" 仅本机可访问（不对局域网开放）。")
        print(" 按 Ctrl+C 可停止服务。")
        print("=======================================================")
        httpd.serve_forever()

def main():
    try:
        port = find_free_port(PORT)
    except RuntimeError as exc:
        print(f"启动失败：{exc}")
        sys.exit(1)

    if port != PORT:
        print(f"端口 {PORT} 已被占用，改用 {port}。")

    url = f'http://{HOST}:{port}'
    server_thread = threading.Thread(target=start_server, args=(port,), daemon=True)
    server_thread.start()

    # Prefer a native desktop window, but only treat a genuinely missing pywebview as
    # the trigger for the browser fallback. The old `except (ImportError, Exception)`
    # swallowed every runtime error too, hiding real GUI failures behind a silent
    # fallback and making them impossible to diagnose.
    try:
        import webview
    except ImportError:
        webview = None

    if webview is not None:
        try:
            print("正在启动原生桌面应用窗口...")
            webview.create_window(
                '洛谷 Markdown 编辑器 (KaTeX 实时预览)',
                url,
                width=1280,
                height=800,
                min_size=(800, 600)
            )
            webview.start()
            return
        except Exception as exc:
            print(f"原生窗口启动失败（{type(exc).__name__}: {exc}），回退到浏览器模式。")

    print(f"正在使用系统默认浏览器打开: {url}")
    webbrowser.open(url)

    try:
        while server_thread.is_alive():
            server_thread.join(timeout=0.5)
    except KeyboardInterrupt:
        print("\n正在退出洛谷 Markdown 编辑器...")
        sys.exit(0)

if __name__ == '__main__':
    main()
