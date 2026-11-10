"""python -m app 으로 서버를 띄운다. 같은 네트워크의 다른 PC는 http://<이 PC의 IP>:8000 으로 접속."""
import os
import socket

import uvicorn


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


if __name__ == "__main__":
    host = os.environ.get("WORKWIKI_HOST", "0.0.0.0")
    port = int(os.environ.get("WORKWIKI_PORT", "8000"))
    print("=" * 60)
    print(" wikiLink 프로토타입")
    print(f"  이 PC에서:        http://localhost:{port}")
    if host == "0.0.0.0":
        print(f"  같은 네트워크에서: http://{lan_ip()}:{port}")
    print("  종료: Ctrl + C")
    print("=" * 60)
    uvicorn.run("app.main:app", host=host, port=port, log_level="warning", proxy_headers=True, forwarded_allow_ips="127.0.0.1")
