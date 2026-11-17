#!/usr/bin/env python3
"""Standalone Stateless Empirical Telemetry Receipt Echo Service for Unmodified Central Bifrost.

Zero databases, zero Bifrost config files, zero local state:
- Authenticates incoming requests from Central Bifrost via Bearer RECEIPT_SHARED_SECRET (HTTP 401 otherwise).
- Returns HTTP 501 on GET /v1/models so unmodified Central Bifrost serves its own configured `keys[0].models` catalog.
- Rejects direct non-receipt POST /v1/chat/completions calls with HTTP 502 WorkstationExecutionRequired.
- Echoes verified workstation `AGY_EMPIRICAL_RECEIPT_V1:` payloads as standard OpenAI `chat.completion` JSON so
  100% stock Central Bifrost records exact empirical tokens, resolved models, routing rules, and Virtual Keys.
"""

import base64
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

EXPECTED_SECRET = os.environ.get("RECEIPT_SHARED_SECRET", "")
RECEIPT_PREFIX = "AGY_EMPIRICAL_RECEIPT_V1:"


class StatelessEchoHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        return

    def _send_json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authorized(self) -> bool:
        if not EXPECTED_SECRET:
            return False
        auth = self.headers.get("Authorization", "")
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        return token == EXPECTED_SECRET

    def do_GET(self) -> None:
        if self.path.startswith("/healthz"):
            self._send_json(200, {"status": "ok", "service": "agy-receipt-echo", "stateless": True})
            return
        if not self._authorized():
            self._send_json(401, {"error": {"message": "Unauthorized", "type": "EchoAuthError"}})
            return
        if self.path.startswith("/v1/models") or self.path.startswith("/models"):
            self._send_json(
                501,
                {
                    "error": {
                        "message": "Stateless echo endpoint; use Bifrost configured model catalog.",
                        "type": "CatalogDelegated",
                    }
                },
            )
            return
        self._send_json(404, {"error": {"message": f"Not found: {self.path}"}})

    def do_POST(self) -> None:
        if not (self.path.startswith("/v1/chat/completions") or self.path.startswith("/chat/completions")):
            self._send_json(404, {"error": {"message": f"Not found: {self.path}"}})
            return
        if not self._authorized():
            self._send_json(401, {"error": {"message": "Unauthorized", "type": "EchoAuthError"}})
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        raw_body = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw_body.decode("utf-8"))
        except Exception as exc:
            self._send_json(400, {"error": {"message": f"Invalid JSON: {exc}", "type": "InvalidRequestError"}})
            return

        encoded_receipt = ""
        for msg in body.get("messages") or []:
            content = msg.get("content")
            if isinstance(content, str) and content.startswith(RECEIPT_PREFIX):
                encoded_receipt = content[len(RECEIPT_PREFIX) :].strip()
                break

        if not encoded_receipt:
            self._send_json(
                502,
                {
                    "error": {
                        "message": (
                            "agy-cli executes locally on the licensed Gemini Enterprise workstation; "
                            "direct gateway inference without an empirical workstation telemetry receipt is not supported."
                        ),
                        "type": "WorkstationExecutionRequired",
                    }
                },
            )
            return

        try:
            pad = "=" * ((4 - len(encoded_receipt) % 4) % 4)
            receipt = json.loads(base64.urlsafe_b64decode(encoded_receipt + pad).decode("utf-8"))
            p_tok = max(0, int(receipt.get("prompt_tokens", 0)))
            c_tok = max(0, int(receipt.get("completion_tokens", 0)))
            th_tok = max(0, int(receipt.get("thinking_tokens", 0)))
            ca_tok = max(0, int(receipt.get("cached_tokens", 0)))
            t_tok = max(0, int(receipt.get("total_tokens", p_tok + c_tok)))
            resolved_model = str(receipt.get("resolved_model") or body.get("model") or "").split("/")[-1]
            comp_id = str(receipt.get("completion_id") or f"chatcmpl-agy-{int(time.time() * 1000)}")
            created = int(receipt.get("created") or time.time())
            resp_text = str(receipt.get("response_text") or "")
            finish_reason = str(receipt.get("finish_reason") or "stop")
        except Exception as exc:
            self._send_json(400, {"error": {"message": f"Malformed telemetry receipt: {exc}", "type": "InvalidReceiptError"}})
            return

        self._send_json(
            200,
            {
                "id": comp_id,
                "object": "chat.completion",
                "created": created,
                "model": resolved_model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": resp_text},
                        "finish_reason": finish_reason,
                    }
                ],
                "usage": {
                    "prompt_tokens": p_tok,
                    "completion_tokens": c_tok,
                    "total_tokens": t_tok,
                    "prompt_tokens_details": {"cached_tokens": ca_tok},
                    "completion_tokens_details": {"reasoning_tokens": th_tok},
                },
            },
        )


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), StatelessEchoHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
