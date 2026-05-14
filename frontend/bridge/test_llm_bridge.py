"""Tests for the LLM bridge: _load_env, WBHTTPHandler /api/chat proxy.

Strategy:
- _load_env: pure function, tested with a temp file.
- do_POST:   start a real one-shot HTTPServer on a random port;
             mock `requests.post` so no real DeepSeek calls are made.
- SSE parse: simulate what wb-llm-panel.js does in Python to verify
             the streaming chunk → delta extraction logic.

Run with:  python -m pytest frontend/bridge/test_llm_bridge.py -v
"""
from __future__ import annotations

import io
import json
import os
import threading
from http.server import HTTPServer
from functools import partial
from unittest.mock import MagicMock, patch

import pytest
import requests as real_requests

# Import the things under test from serial_bridge
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from serial_bridge import _load_env, WBHTTPHandler


# ── helpers ──────────────────────────────────────────────────────────────────

def _make_server(directory: str = "/tmp") -> tuple[HTTPServer, int]:
    handler = partial(WBHTTPHandler, directory=directory)
    srv = HTTPServer(("127.0.0.1", 0), handler)
    return srv, srv.server_address[1]


def _handle_one(srv: HTTPServer):
    """Handle exactly one request in the calling thread."""
    srv.handle_request()


def _post(port: int, path: str, body: dict | None = None) -> real_requests.Response:
    return real_requests.post(
        f"http://127.0.0.1:{port}{path}",
        json=body or {},
        stream=True,
        timeout=5,
    )


def _get(port: int, path: str) -> real_requests.Response:
    return real_requests.get(f"http://127.0.0.1:{port}{path}", timeout=5)


# ── _load_env ─────────────────────────────────────────────────────────────────

def test_load_env_reads_key(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("DEEPSEEK_API_KEY=dummy_test_key_123\n")

    # Point _load_env at our temp dir by monkey-patching __file__ of the module
    import serial_bridge
    monkeypatch.setattr(serial_bridge, "__file__", str(tmp_path / "serial_bridge.py"))
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    _load_env()
    assert os.environ["DEEPSEEK_API_KEY"] == "dummy_test_key_123"


def test_load_env_ignores_comments(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("# comment\nFOO=bar\n")

    import serial_bridge
    monkeypatch.setattr(serial_bridge, "__file__", str(tmp_path / "serial_bridge.py"))
    monkeypatch.delenv("FOO", raising=False)

    _load_env()
    assert os.environ.get("FOO") == "bar"


def test_load_env_does_not_overwrite(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("DEEPSEEK_API_KEY=from_file\n")

    import serial_bridge
    monkeypatch.setattr(serial_bridge, "__file__", str(tmp_path / "serial_bridge.py"))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "already_set")

    _load_env()
    assert os.environ["DEEPSEEK_API_KEY"] == "already_set"  # setdefault, no overwrite


def test_load_env_missing_file(tmp_path, monkeypatch):
    """No .env file → no crash, no change."""
    import serial_bridge
    monkeypatch.setattr(serial_bridge, "__file__", str(tmp_path / "serial_bridge.py"))
    monkeypatch.delenv("SOME_KEY", raising=False)

    _load_env()  # must not raise
    assert os.environ.get("SOME_KEY") is None


# ── do_POST: missing API key → 500 ───────────────────────────────────────────

def test_post_missing_api_key(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    srv, port = _make_server()
    t = threading.Thread(target=_handle_one, args=(srv,), daemon=True)
    t.start()

    resp = _post(port, "/api/chat", {"messages": []})
    t.join(timeout=3)

    assert resp.status_code == 500
    srv.server_close()


# ── do_POST: wrong path → 404 ────────────────────────────────────────────────

def test_post_wrong_path(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "dummy_key")
    srv, port = _make_server()
    t = threading.Thread(target=_handle_one, args=(srv,), daemon=True)
    t.start()

    resp = _post(port, "/not/api/chat")
    t.join(timeout=3)

    assert resp.status_code == 404
    srv.server_close()


# ── do_POST: mocked DeepSeek → SSE forwarded correctly ──────────────────────

def _fake_deepseek_response(content_chunks: list[str]) -> MagicMock:
    """Build a mock requests.Response that streams SSE lines."""
    def iter_content(chunk_size=None):
        for text in content_chunks:
            yield text.encode()

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.iter_content = iter_content
    return mock_resp


def _sse_chunks_for(deltas: list[str]) -> list[str]:
    """Format a list of content deltas as DeepSeek SSE lines."""
    lines = []
    for d in deltas:
        payload = json.dumps({"choices": [{"delta": {"content": d}}]})
        lines.append(f"data: {payload}\n\n")
    lines.append("data: [DONE]\n\n")
    return lines


def test_post_streams_sse(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "dummy_test_key")

    sse = _sse_chunks_for(["Hello", " World"])
    fake = _fake_deepseek_response(sse)

    fake_requests_mod = MagicMock()
    fake_requests_mod.post.return_value = fake

    srv, port = _make_server()
    t = threading.Thread(target=_handle_one, args=(srv,), daemon=True)
    t.start()

    # Use urllib so patching sys.modules["requests"] doesn't affect the test caller.
    import urllib.request as _urllib
    body = json.dumps({"model": "deepseek-v4-pro", "messages": []}).encode()
    req = _urllib.Request(
        f"http://127.0.0.1:{port}/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with patch.dict("sys.modules", {"requests": fake_requests_mod}):
        with _urllib.urlopen(req, timeout=5) as resp:
            status = resp.status
            content_type = resp.headers.get("Content-Type", "")
            body_text = resp.read().decode()

    t.join(timeout=5)
    srv.server_close()

    assert status == 200
    assert "text/event-stream" in content_type
    for chunk in sse:
        assert chunk.strip() in body_text


# ── SSE parsing (mirrors wb-llm-panel.js _onSend logic) ──────────────────────

def _parse_sse_stream(raw: str) -> str:
    """Replicate the JS streaming parser: buffer → split on \\n → extract deltas."""
    full = ""
    buffer = raw
    lines = buffer.split("\n")
    buffer = lines[-1]          # last potentially-incomplete line kept in buffer
    for line in lines[:-1]:     # process complete lines
        if not line.startswith("data: "):
            continue
        data = line[6:].strip()
        if data == "[DONE]":
            continue
        try:
            delta = json.loads(data)["choices"][0]["delta"].get("content", "")
            full += delta
        except (json.JSONDecodeError, KeyError, IndexError):
            pass
    return full


def test_sse_parse_simple():
    raw = (
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n'
        'data: {"choices":[{"delta":{"content":" World"}}]}\n'
        'data: [DONE]\n'
    )
    assert _parse_sse_stream(raw) == "Hello World"


def test_sse_parse_workspace_update_tag():
    """workspace_update XML is present in full content and regex extractable."""
    import re
    rules_json = '{"version":3,"variables":[],"virtual_channels":[],"rules":[]}'
    response_text = f"Here is your rule.\n<workspace_update>{rules_json}</workspace_update>"

    match = re.search(r"<workspace_update>([\s\S]*?)</workspace_update>", response_text)
    assert match is not None
    parsed = json.loads(match.group(1).strip())
    assert parsed["version"] == 3
    assert "rules" in parsed


def test_sse_parse_invalid_json_in_update():
    """Malformed JSON inside workspace_update should not crash (try-catch in JS)."""
    import re
    response_text = "<workspace_update>NOT VALID JSON</workspace_update>"
    match = re.search(r"<workspace_update>([\s\S]*?)</workspace_update>", response_text)
    assert match is not None
    try:
        json.loads(match.group(1).strip())
        assert False, "should have raised"
    except json.JSONDecodeError:
        pass  # JS catches this and ignores the proposed update


def test_sse_parse_module_chip_tokens():
    """@word tokens that map to module IDs should be detectable."""
    import re
    response = "When @imu acceleration exceeds 0.8, trigger @vibration for 500ms."
    tokens = re.findall(r"@([A-Za-z][A-Za-z0-9_]*)", response)
    assert "imu" in tokens
    assert "vibration" in tokens


def test_sse_parse_partial_chunks():
    """A data: line split across two chunks must be handled via buffering."""
    # Simulate receiving the line in two parts (as could happen with real streaming)
    chunk1 = 'data: {"choices":[{"delta":{"con'
    chunk2 = 'tent":"Hi"}}]}\ndata: [DONE]\n'
    combined = chunk1 + chunk2
    result = _parse_sse_stream(combined)
    assert result == "Hi"


# ── payload structure sent to DeepSeek ───────────────────────────────────────

def test_payload_model_name():
    """Verify wb-llm-panel.js uses deepseek-v4-pro, not an old model name."""
    panel_path = pathlib.Path(__file__).parent.parent / "js" / "components" / "wb-llm-panel.js"
    src = panel_path.read_text()
    assert "deepseek-v4-pro" in src, "Model name must be deepseek-v4-pro"
    assert "deepseek-chat" not in src, "Old model name deepseek-chat must be removed"


def test_payload_has_stream_true():
    """Streaming must be enabled in the fetch payload."""
    panel_path = pathlib.Path(__file__).parent.parent / "js" / "components" / "wb-llm-panel.js"
    src = panel_path.read_text()
    assert "stream: true" in src
