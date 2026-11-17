#!/usr/bin/env python3
"""Streaming ChatGPT Web text worker reusing OpenAIWebImageClient session & sentinel auth.

Reads one JSON request payload from stdin and either:
- streams NDJSON events (`delta`, `done`, `error`) to stdout when invoked with `--stream`
  or `payload["stream_events"] is True`, or
- prints a single JSON result object `{ok: True, text, ...}` / `{ok: False, ...}`.
"""

from __future__ import annotations

import json
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, Optional, Sequence

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from image_worker import (
    ImageWorkerError,
    OpenAIWebImageClient,
    UpstreamHTTPError,
    _apply_patch_op,
    _assistant_message_text,
    _is_token_invalid_text,
    _is_visible_assistant_message,
    _iter_sse_payloads,
    _sanitize_error_text,
    _sanitize_output_text,
)

MAX_STDIN_BYTES = 16 * 1024 * 1024
DEFAULT_WEB_TEXT_MODEL = "gpt-5.6-luna"
VALID_THINKING_EFFORTS = {"low", "medium", "high", "xhigh"}
ALLOWED_ROLES = {"system", "developer", "user", "assistant"}


def normalize_web_text_model(model: Any) -> str:
    raw = str(model or "").strip()
    if raw.startswith("gptfree-pool/"):
        raw = raw[len("gptfree-pool/") :].strip()
    return raw or DEFAULT_WEB_TEXT_MODEL


def normalize_thinking_effort(effort: Any) -> str:
    val = str(effort or "").strip().lower()
    if val in ("", "none", "minimal"):
        return ""
    if val == "max":
        return "xhigh"
    if val in VALID_THINKING_EFFORTS:
        return val
    return ""


def normalize_web_messages(
    raw_messages: Any,
) -> tuple[list[Dict[str, Any]], list[str], str, set[str]]:
    """Convert normalized `{role, content}` messages into ChatGPT Web payloads.

    Returns `(web_messages, assistant_history_messages, last_user_text, input_message_ids)`.
    """
    if not isinstance(raw_messages, list):
        raise ImageWorkerError(
            "messages must be a non-empty list",
            http_status=400,
            error_code="invalid_request",
        )

    web_messages: list[Dict[str, Any]] = []
    assistant_history: list[str] = []
    input_message_ids: set[str] = set()
    last_user_text = ""

    for item in raw_messages:
        if not isinstance(item, dict):
            continue
        raw_role = str(item.get("role") or "user").strip().lower()
        if raw_role not in ALLOWED_ROLES:
            raw_role = "user"
        web_role = "system" if raw_role == "developer" else raw_role
        content = str(item.get("content") or "")
        if not content.strip():
            continue

        msg_id = str(uuid.uuid4())
        input_message_ids.add(msg_id)
        web_messages.append(
            {
                "id": msg_id,
                "author": {"role": web_role},
                "create_time": time.time(),
                "content": {"content_type": "text", "parts": [content]},
                "metadata": {
                    "developer_mode_connector_ids": [],
                    "selected_github_repos": [],
                    "selected_all_github_repos": False,
                    "serialization_metadata": {"custom_symbol_offsets": []},
                },
            }
        )
        if web_role == "assistant":
            assistant_history.append(content.strip())
        elif web_role == "user":
            last_user_text = content.strip()

    if not web_messages:
        raise ImageWorkerError(
            "Request must contain at least one non-empty message",
            http_status=400,
            error_code="invalid_request",
        )
    if not last_user_text:
        last_user_text = str(web_messages[-1]["content"]["parts"][0]).strip()
    return web_messages, assistant_history, last_user_text, input_message_ids


def web_message_text(message: Dict[str, Any]) -> str:
    content = message.get("content")
    if not isinstance(content, dict):
        return ""
    parts = content.get("parts")
    if not isinstance(parts, list) or not parts:
        return ""
    return str(parts[0] or "")


def _web_message_role(message: Dict[str, Any]) -> str:
    author = message.get("author")
    if not isinstance(author, dict):
        return ""
    return str(author.get("role") or "").strip().lower()


def _new_web_message(role: str, text: str) -> Dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "author": {"role": role},
        "create_time": time.time(),
        "content": {"content_type": "text", "parts": [text]},
        "metadata": {
            "developer_mode_connector_ids": [],
            "selected_github_repos": [],
            "selected_all_github_repos": False,
            "serialization_metadata": {"custom_symbol_offsets": []},
        },
    }


def fold_system_messages(web_messages: Sequence[Dict[str, Any]]) -> tuple[list[Dict[str, Any]], int]:
    """把 system 角色合并进第一条 user 消息，返回 (新消息列表, 合并了几条)。

    为什么需要：ChatGPT Web 的 conversation body 只认 user / assistant —— 图片链路
    一直只发一条 user 消息，从来没撞上这个问题；文本链路会把客户端给的 system /
    developer 原样搬进 `messages[].author.role`。agent 类客户端（PI Agent 这种）
    几乎一定带 system prompt，上游就可能整单回 422「Invalid conversation body」，
    而且只回这一句，看不出是哪个字段。

    合并是最不坏的降级：语义还在（从「系统指令」变成「用户交代的前置说明」），
    但不会因为一个角色名把整单打死。只在上游真的拒绝请求体（400/422）时才会用到，
    正常请求一次就成，不会因为多准备一套 body 而变慢。

    返回的是副本，调用方的 web_messages 不会被改。
    """
    system_texts: list[str] = []
    kept: list[Dict[str, Any]] = []
    for message in web_messages:
        if _web_message_role(message) == "system":
            text = web_message_text(message).strip()
            if text:
                system_texts.append(text)
            continue
        kept.append(message)
    if not system_texts:
        return list(web_messages), 0

    prefix = "\n\n".join(system_texts)
    folded = [json.loads(json.dumps(m)) for m in kept]
    first_user = next((m for m in folded if _web_message_role(m) == "user"), None)
    if first_user is None:
        # 只有 system + assistant 历史：合并后的说明本身就得当一条 user 消息发出去，
        # 否则整单没有 user turn，上游同样不认。
        folded.insert(0, _new_web_message("user", prefix))
    else:
        existing = web_message_text(first_user).strip()
        first_user["content"] = {
            "content_type": "text",
            "parts": [f"{prefix}\n\n{existing}" if existing else prefix],
        }
    return folded, len(system_texts)


def describe_conversation_body(
    web_messages: Sequence[Dict[str, Any]],
    *,
    model: str,
    effort: str,
) -> str:
    """一句话描述「我们发出去的 body」，塞进上游错误的 hint。

    上游只回一句 Invalid conversation body 的时候，这句话就是全部线索 ——
    得让人一眼看出：发的哪个模型、带了哪些角色、有没有 thinking_effort。
    """
    roles: list[str] = []
    for message in web_messages:
        role = _web_message_role(message) or "?"
        if not roles or roles[-1] != role:
            roles.append(role)
    bits = [f"model={model}", f"角色={'/'.join(roles) or '无'}", f"{len(web_messages)} 条消息"]
    if effort:
        bits.append(f"effort={effort}")
    return "｜".join(bits)


def build_conversation_body(
    web_messages: Sequence[Dict[str, Any]],
    *,
    upstream_model: str,
    effort: str,
    timezone_offset_min: int,
    timezone_name: str,
) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "action": "next",
        "messages": list(web_messages),
        "parent_message_id": "client-created-root",
        "model": upstream_model,
        "client_prepare_state": "sent",
        "timezone_offset_min": int(timezone_offset_min),
        "timezone": timezone_name,
        "history_and_training_disabled": True,
        "conversation_mode": {"kind": "primary_assistant"},
        "enable_message_followups": True,
        "system_hints": [],
        "supports_buffering": True,
        "supported_encodings": ["v1"],
        "client_contextual_info": {
            "is_dark_mode": False,
            "time_since_loaded": 25,
            "page_height": 900,
            "page_width": 1200,
            "pixel_ratio": 1,
            "screen_height": 1080,
            "screen_width": 1920,
            "app_name": "chatgpt.com",
        },
        "paragen_cot_summary_display_override": "allow",
        "force_parallel_switch": "auto",
    }
    if effort:
        body["thinking_effort"] = effort
    return body


def conversation_body_variants(
    web_messages: Sequence[Dict[str, Any]],
    *,
    effort: str,
) -> list[tuple[list[Dict[str, Any]], str, str]]:
    """按「最保守的降级顺序」给出要试的 body 形态：[(messages, effort, 说明)]。

    第一项永远是原样的请求 —— 现在能跑通的客户端不该因为这次改动多付出任何代价，
    只有上游 400/422 拒绝请求体时才往下试。
    """
    folded_messages, folded_count = fold_system_messages(web_messages)
    variants: list[tuple[list[Dict[str, Any]], str, str]] = [
        (list(web_messages), effort, "原始"),
    ]
    if folded_count:
        variants.append((folded_messages, effort, "system 折进 user"))
        if effort:
            variants.append((folded_messages, "", "system 折进 user + 去 effort"))
    elif effort:
        variants.append((list(web_messages), "", "去 effort"))
    return variants


def ensure_ok_with_hint(response: Any, context: str, hint: str) -> None:
    """_ensure_ok 的薄包装：把「我们发了什么」挂到异常上再抛。

    不去改 image_worker 里的 UpstreamHTTPError —— 生图链路一行都不动。hint 只是
    文本链路自己的补充说明，_error_response_dict 用 getattr 读，没有也不影响。
    """
    try:
        OpenAIWebImageClient._ensure_ok(response, context)
    except UpstreamHTTPError as exc:
        exc.hint = hint
        raise


def strip_history_prefix(
    text: str,
    assistant_history_messages: Sequence[str],
    *,
    hold_partial_prefix: bool = False,
) -> str:
    """Strip echoed assistant history blocks while preserving legitimate short replies on finalize."""
    clean = str(text or "")
    joined = "\n\n".join(m for m in assistant_history_messages if m)
    candidates: list[str] = []
    if joined:
        candidates.append(joined)
    for msg in assistant_history_messages:
        if msg and msg not in candidates:
            candidates.append(msg)

    for cand in candidates:
        if clean.startswith(cand):
            clean = clean[len(cand) :].lstrip()
        elif hold_partial_prefix and clean and cand.startswith(clean):
            return ""
    return clean


def _is_hidden_text_path(path: str) -> bool:
    if not path:
        return False
    if path == "/message/content/parts/0":
        return False
    return (
        "/thoughts/" in path
        or "reasoning" in path
        or path.startswith("/message/content/")
    )


def _infer_sse_error_status(code: str, message: str) -> int:
    lowered = f"{code} {message}".lower()
    if any(tok in lowered for tok in ("rate_limit", "too many", "limit_exceeded", "quota", "usage_limit")):
        return 429
    if any(tok in lowered for tok in ("unauthorized", "token_revoked", "invalid_token", "session_expired")):
        return 401
    if any(tok in lowered for tok in ("moderation", "content_policy", "safety", "policy")):
        return 400
    if "forbidden" in lowered:
        return 403
    return 502


@dataclass
class WebTextStreamTracker:
    """Stateful parser tracking ChatGPT Web v1 SSE patches into clean assistant text deltas."""

    assistant_history_messages: tuple[str, ...] = ()
    input_message_ids: frozenset[str] = field(default_factory=frozenset)
    conversation_id: str = ""
    active_role: str = "assistant"
    active_channel: str = ""
    active_recipient: str = ""
    active_content_type: str = "text"
    active_hidden: bool = False
    active_is_input_echo: bool = False
    current_msg_id: str = ""
    completed_segments: list[str] = field(default_factory=list)
    current_msg_raw: str = ""
    last_patch_path: str = "/message/content/parts/0"
    emitted_text: str = ""
    blocked: bool = False
    model_slug: str = ""

    def _is_active_visible(self) -> bool:
        if self.active_is_input_echo:
            return False
        if self.active_role != "assistant":
            return False
        if self.active_hidden:
            return False
        if self.active_recipient and self.active_recipient != "all":
            return False
        if self.active_channel and self.active_channel != "final":
            return False
        if self.active_content_type in {"thoughts", "reasoning_recap", "code"}:
            return False
        return True

    def _combined_sanitized(self) -> str:
        raw = "\n\n".join(s for s in [*self.completed_segments, self.current_msg_raw] if s)
        return _sanitize_output_text(raw)

    def _next_delta(self, *, hold_partial_prefix: bool) -> str:
        sanitized = self._combined_sanitized()
        if not self.input_message_ids and self.assistant_history_messages:
            clean = strip_history_prefix(
                sanitized,
                self.assistant_history_messages,
                hold_partial_prefix=hold_partial_prefix,
            )
        else:
            clean = sanitized
        if len(clean) > len(self.emitted_text) and clean.startswith(self.emitted_text):
            delta = clean[len(self.emitted_text) :]
            self.emitted_text = clean
            return delta
        return ""

    def _handle_message(self, msg: dict[str, Any]) -> None:
        msg_id = str(msg.get("id") or "")
        role = str(((msg.get("author") or {}).get("role")) or "").strip().lower()
        content = msg.get("content")
        content_type = (
            str(content.get("content_type") or "").strip().lower()
            if isinstance(content, dict)
            else ""
        )
        metadata = msg.get("metadata") or {}
        if not isinstance(metadata, dict):
            metadata = {}

        if msg_id and msg_id in self.input_message_ids:
            self.active_is_input_echo = True
            self.active_role = role
            self.last_patch_path = ""
            return

        previous_visible = self._is_active_visible()
        if msg_id and msg_id != self.current_msg_id:
            if previous_visible and self.current_msg_raw:
                self.completed_segments.append(self.current_msg_raw)
            self.current_msg_id = msg_id
            self.current_msg_raw = ""

        self.active_is_input_echo = False
        self.active_role = role
        self.active_channel = str(msg.get("channel") or "").strip().lower()
        self.active_recipient = str(msg.get("recipient") or "").strip().lower()
        self.active_content_type = content_type
        self.active_hidden = metadata.get("is_visually_hidden_from_conversation") is True

        slug = str(metadata.get("model_slug") or "").strip()
        if slug and self.active_role == "assistant":
            self.model_slug = slug

        if (
            self.active_role == "assistant"
            and self.active_content_type not in {"thoughts", "reasoning_recap", "code"}
        ):
            self.last_patch_path = "/message/content/parts/0"
            msg_text = _assistant_message_text(msg)
            if msg_text and self._is_active_visible():
                self.current_msg_raw = msg_text
        else:
            self.last_patch_path = ""

    def _apply_visibility_op(self, op: dict[str, Any]) -> None:
        op_p = op.get("p")
        op_o = op.get("o")
        op_v = op.get("v")
        if not isinstance(op_p, str):
            return

        if op_p == "/message/metadata/is_visually_hidden_from_conversation":
            if op_o == "remove":
                self.active_hidden = False
            elif op_o in ("add", "replace"):
                self.active_hidden = op_v is True
        elif op_p == "/message/channel":
            if op_o == "remove":
                self.active_channel = ""
            elif isinstance(op_v, str):
                self.active_channel = op_v.strip().lower()
        elif op_p == "/message/recipient":
            if op_o == "remove":
                self.active_recipient = ""
            elif isinstance(op_v, str):
                self.active_recipient = op_v.strip().lower()
        elif op_p == "/message/metadata" and isinstance(op_v, dict):
            if "is_visually_hidden_from_conversation" in op_v:
                self.active_hidden = op_v["is_visually_hidden_from_conversation"] is True
            slug = str(op_v.get("model_slug") or "").strip()
            if slug and self.active_role == "assistant":
                self.model_slug = slug

    def _handle_patch_op(self, op: dict[str, Any], *, apply_visibility: bool = True) -> None:
        op_p = op.get("p")
        op_o = op.get("o")
        op_v = op.get("v")

        if op_p == "" and op_o == "add" and isinstance(op_v, dict) and isinstance(op_v.get("message"), dict):
            self._handle_message(op_v["message"])
            return

        if apply_visibility and isinstance(op_p, str) and op_p in (
            "/message/metadata/is_visually_hidden_from_conversation",
            "/message/channel",
            "/message/recipient",
            "/message/metadata",
        ):
            self._apply_visibility_op(op)
            return

        if isinstance(op_p, str) and op_p:
            if op_p == "/message/content/parts/0":
                self.last_patch_path = "/message/content/parts/0"
                if self._is_active_visible() and isinstance(op_v, (str, int, float)):
                    self.current_msg_raw = _apply_patch_op(op, self.current_msg_raw)
                return
            if _is_hidden_text_path(op_p):
                self.last_patch_path = op_p
            return

        if op_p in (None, "") and op_o in ("append", "replace") and isinstance(op_v, str):
            if self._is_active_visible() and self.last_patch_path == "/message/content/parts/0":
                self.current_msg_raw = _apply_patch_op(op, self.current_msg_raw)

    def _handle_patch_list(self, items: list[Any]) -> None:
        dict_items = [item for item in items if isinstance(item, dict)]
        has_new_message = any(
            item.get("p") == "" and item.get("o") == "add" and isinstance(item.get("v"), dict) and "message" in item["v"]
            for item in dict_items
        )
        if not has_new_message:
            # ChatGPT Web often sends parts/0 append BEFORE removing is_visually_hidden_from_conversation in the same patch list.
            for item in dict_items:
                self._apply_visibility_op(item)
            for item in dict_items:
                self._handle_patch_op(item, apply_visibility=False)
            return
        for item in dict_items:
            self._handle_patch_op(item, apply_visibility=True)

    def feed_payload(self, payload: str) -> str:
        if not payload or payload == "[DONE]":
            return ""
        try:
            event = json.loads(payload)
        except Exception:
            return ""
        if not isinstance(event, dict):
            return ""

        conv_id = event.get("conversation_id")
        if conv_id:
            self.conversation_id = str(conv_id)
        val = event.get("v")
        if isinstance(val, dict) and val.get("conversation_id"):
            self.conversation_id = str(val["conversation_id"])

        if event.get("type") == "moderation":
            mod = event.get("moderation_response")
            if isinstance(mod, dict) and mod.get("blocked") is True:
                self.blocked = True

        err_val = event.get("error")
        if err_val:
            if isinstance(err_val, dict):
                err_msg = str(err_val.get("message") or err_val.get("code") or err_val)
                err_code = str(err_val.get("code") or "upstream_error")
            else:
                err_msg = str(err_val)
                err_code = "upstream_error"
            status = _infer_sse_error_status(err_code, err_msg)
            raise ImageWorkerError(
                _sanitize_error_text(err_msg) or "Upstream conversation error",
                http_status=status,
                error_code=err_code,
                conversation_id=self.conversation_id,
            )

        if isinstance(event.get("message"), dict):
            self._handle_message(event["message"])
        elif isinstance(val, dict) and isinstance(val.get("message"), dict):
            self._handle_message(val["message"])
        elif event.get("o") == "patch" and isinstance(val, list):
            self._handle_patch_list(val)
        elif isinstance(event.get("p"), str):
            self._handle_patch_op(event)
        elif isinstance(val, list):
            self._handle_patch_list(val)
        elif isinstance(val, str) and "p" not in event and "o" not in event:
            if self._is_active_visible() and self.last_patch_path == "/message/content/parts/0":
                self.current_msg_raw += val

        return self._next_delta(hold_partial_prefix=True)

    def finalize_delta(self) -> str:
        return self._next_delta(hold_partial_prefix=False)


class OpenAIWebTextClient(OpenAIWebImageClient):
    """Reuses OpenAIWebImageClient cookies, sentinel PoW, Turnstile and headers for text chat."""

    def _prepare_text_conversation(
        self,
        *,
        upstream_model: str,
        partial_query_text: str,
        thinking_effort: str,
        timezone_offset_min: int,
        timezone_name: str,
        requirements: Any,
    ) -> tuple[str, str]:
        path = "/backend-api/f/conversation/prepare"
        current_effort = thinking_effort

        for attempt in range(2):
            payload: Dict[str, Any] = {
                "action": "next",
                "fork_from_shared_post": False,
                "parent_message_id": "client-created-root",
                "model": upstream_model,
                "client_prepare_state": "success",
                "timezone_offset_min": int(timezone_offset_min),
                "timezone": timezone_name,
                "conversation_mode": {"kind": "primary_assistant"},
                "system_hints": [],
                "supports_buffering": True,
                "supported_encodings": ["v1"],
                "client_contextual_info": {"app_name": "chatgpt.com"},
            }
            if partial_query_text:
                payload["partial_query"] = {
                    "id": str(uuid.uuid4()),
                    "author": {"role": "user"},
                    "content": {"content_type": "text", "parts": [partial_query_text]},
                }
            if current_effort:
                payload["thinking_effort"] = current_effort

            response = self.session.post(
                self.base_url + path,
                headers=self._image_headers(path, requirements, accept="application/json"),
                json=payload,
                timeout=60,
            )
            if attempt == 0 and current_effort and response.status_code in (400, 422):
                # 原来还要求响应体里出现 "thinking_effort" 才重试，可上游常常只回一句
                # 「Invalid conversation body」—— 那个条件永远不会成立，等于没写。
                # 这一轮带了 effort 就先当它的锅，去掉再来一次。
                current_effort = ""
                continue
            ensure_ok_with_hint(
                response,
                path,
                f"model={upstream_model}｜prepare｜effort={current_effort or '无'}",
            )
            data = response.json() if hasattr(response, "json") else {}
            return str((data or {}).get("conduit_token") or ""), current_effort

        return "", current_effort

    def stream_text(
        self,
        *,
        messages: Any,
        model: str = DEFAULT_WEB_TEXT_MODEL,
        thinking_effort: str = "",
        timezone_offset_min: int = -480,
        timezone_name: str = "Asia/Shanghai",
        stream_timeout: float = 180.0,
        on_delta: Optional[Callable[[str, str], None]] = None,
    ) -> Dict[str, Any]:
        upstream_model = normalize_web_text_model(model)
        effort = normalize_thinking_effort(thinking_effort)
        web_messages, assistant_history, last_user_text, input_ids = normalize_web_messages(messages)

        self._bootstrap()
        requirements = self._get_chat_requirements()

        conduit_token, effort = self._prepare_text_conversation(
            upstream_model=upstream_model,
            partial_query_text=last_user_text,
            thinking_effort=effort,
            timezone_offset_min=timezone_offset_min,
            timezone_name=timezone_name,
            requirements=requirements,
        )

        path = "/backend-api/f/conversation"
        tracker = WebTextStreamTracker(
            assistant_history_messages=tuple(assistant_history),
            input_message_ids=frozenset(input_ids),
        )
        variants = conversation_body_variants(web_messages, effort=effort)
        tried: list[str] = []
        resp = None

        for index, (variant_messages, variant_effort, label) in enumerate(variants):
            tried.append(label)
            body = build_conversation_body(
                variant_messages,
                upstream_model=upstream_model,
                effort=variant_effort,
                timezone_offset_min=timezone_offset_min,
                timezone_name=timezone_name,
            )
            hint = describe_conversation_body(
                variant_messages,
                model=upstream_model,
                effort=variant_effort,
            )

            candidate = self.session.post(
                self.base_url + path,
                headers=self._image_headers(
                    path,
                    requirements,
                    conduit_token=conduit_token,
                    accept="text/event-stream",
                ),
                json=body,
                timeout=stream_timeout,
                stream=True,
            )
            try:
                ensure_ok_with_hint(candidate, path, hint)
            except UpstreamHTTPError as exc:
                try:
                    candidate.close()
                except Exception:
                    pass
                # 只有「上游拒绝请求体」（400/422）才值得换一套 body 重来：5xx、限流、
                # token 失效跟 body 长什么样无关，重试只是白等一轮。
                is_last = index == len(variants) - 1
                if int(getattr(exc, "status_code", 0) or 0) not in (400, 422) or is_last:
                    if is_last and len(tried) > 1:
                        # 降级全试完了还是不行：把试过哪几种形态一并带上，否则下一个人
                        # 只能看到「最后一次最朴素的 body 被拒」，反而更难定位。
                        exc.hint = f"{hint}｜已试：{'→'.join(tried)}"
                    raise
                continue
            resp = candidate
            break

        assert resp is not None
        try:
            for payload in _iter_sse_payloads(resp):
                if payload == "[DONE]":
                    break
                delta = tracker.feed_payload(payload)
                if delta and on_delta is not None:
                    on_delta(delta, tracker.model_slug)
        finally:
            try:
                resp.close()
            except Exception:
                pass

        tail = tracker.finalize_delta()
        if tail and on_delta is not None:
            on_delta(tail, tracker.model_slug)

        if tracker.blocked and not tracker.emitted_text:
            raise ImageWorkerError(
                "Response blocked by upstream moderation",
                http_status=400,
                error_code="content_policy_violation",
                conversation_id=tracker.conversation_id,
            )

        return {
            "ok": True,
            "text": tracker.emitted_text,
            "conversation_id": tracker.conversation_id,
            "model": tracker.model_slug or upstream_model,
        }


def _emit_ndjson(event: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=True) + "\n")
    sys.stdout.flush()


_SANITIZE_EMPTY_FALLBACK = "Image generation failed"


def upstream_body_text(body: Any) -> str:
    """上游原文：dict / list 用 JSON 表示，不要用 Python 的 repr。

    `str({"detail": "Invalid conversation body"})` 得到的是
    `{'detail': 'Invalid conversation body'}` —— 单引号、看着像内部调试信息，
    用户把这句话贴到 issue 里，没人认得出这是上游的 HTTP 响应体。JSON 既忠实
    又可读，和上游实际返回的东西一致。
    """
    if isinstance(body, (dict, list)):
        try:
            return json.dumps(body, ensure_ascii=False)
        except Exception:
            return str(body)
    return str(body or "")


def _short_context(context: str) -> str:
    """把上游路径缩成一眼能读的形态：/backend-api/f/conversation → /f/conversation。"""
    text = str(context or "").strip()
    if not text:
        return ""
    return text[len("/backend-api"):] if text.startswith("/backend-api") else text


def _upstream_error_message(exc: "UpstreamHTTPError") -> str:
    """把上游错误拼成一句人话，顺序是「状态 → 上游原文 → 我们发了什么」。

    原文必须紧跟状态码：Node 层还会再脱敏并截到 180 字，放后面的信息会被切掉，
    而原文恰恰是唯一能说明「上游到底在抱怨什么」的东西。
    """
    raw = _sanitize_error_text(upstream_body_text(exc.body))
    if raw == _SANITIZE_EMPTY_FALLBACK:
        raw = ""

    bits: list[str] = []
    where = _short_context(getattr(exc, "context", ""))
    if where:
        bits.append(where)
    hint = _sanitize_error_text(getattr(exc, "hint", "") or "")
    if hint and hint != _SANITIZE_EMPTY_FALLBACK:
        bits.append(hint)

    status = int(getattr(exc, "status_code", 0) or 0)
    if raw:
        msg = f"上游 {status}：{raw}"
    else:
        msg = f"上游 {status}"
    if bits:
        msg += f"（{'｜'.join(bits)}）"
    return msg


def _error_response_dict(exc: Exception) -> Dict[str, Any]:
    if isinstance(exc, UpstreamHTTPError):
        body_text = _sanitize_error_text(upstream_body_text(exc.body))
        if body_text == _SANITIZE_EMPTY_FALLBACK:
            body_text = ""
        msg = _upstream_error_message(exc)
        token_invalid = exc.status_code == 401 or _is_token_invalid_text(body_text or str(exc))
        if token_invalid and exc.status_code in (200, 403):
            status = 401
        else:
            status = exc.status_code
        code = (
            "rate_limit_exceeded"
            if status == 429
            else ("invalid_token" if status == 401 else "upstream_http_error")
        )
        return {
            "ok": False,
            "type": "error",
            "http_status": status,
            "error_code": code,
            "error": _sanitize_error_text(msg),
            "token_invalid": token_invalid,
            "retry_after": exc.retry_after,
        }
    if isinstance(exc, ImageWorkerError):
        msg = _sanitize_error_text(str(exc)) or "Upstream text generation error"
        token_invalid = exc.http_status == 401 or _is_token_invalid_text(msg)
        return {
            "ok": False,
            "type": "error",
            "http_status": 401 if token_invalid else exc.http_status,
            "error_code": exc.error_code or "upstream_error",
            "error": msg,
            "token_invalid": token_invalid,
            "retry_after": exc.retry_after,
        }
    msg = _sanitize_error_text(str(exc)) or exc.__class__.__name__
    token_invalid = _is_token_invalid_text(msg)
    return {
        "ok": False,
        "type": "error",
        "http_status": 401 if token_invalid else 502,
        "error_code": "worker_error",
        "error": msg,
        "token_invalid": token_invalid,
        "retry_after": None,
    }


def handle_text_payload(
    data: Any,
    *,
    session: Any = None,
    on_delta: Optional[Callable[[str, str], None]] = None,
) -> Dict[str, Any]:
    try:
        if not isinstance(data, dict):
            raise ImageWorkerError("Payload must be a JSON object", http_status=400, error_code="invalid_request")
        access_token = str(data.get("access_token") or "").strip()
        if not access_token:
            raise ImageWorkerError(
                "Missing access_token for Web text request",
                http_status=401,
                error_code="missing_token",
            )
        proxy = str(data.get("proxy") or "").strip()
        model = str(data.get("model") or DEFAULT_WEB_TEXT_MODEL).strip()
        effort = str(data.get("thinking_effort") or "").strip()
        tz_offset = int(data.get("timezone_offset_min") or -480)
        tz_name = str(data.get("timezone") or "Asia/Shanghai").strip() or "Asia/Shanghai"
        timeout_val = float(data.get("stream_timeout") or 180.0)

        with OpenAIWebTextClient(
            access_token,
            proxy=proxy,
            upstream_model=normalize_web_text_model(model),
            thinking_effort=normalize_thinking_effort(effort),
            session=session,
        ) as client:
            result = client.stream_text(
                messages=data.get("messages"),
                model=model,
                thinking_effort=effort,
                timezone_offset_min=tz_offset,
                timezone_name=tz_name,
                stream_timeout=timeout_val,
                on_delta=on_delta,
            )
            return result
    except Exception as exc:
        return _error_response_dict(exc)


def main() -> None:
    stream_events = "--stream" in sys.argv[1:]
    try:
        raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
        if len(raw) > MAX_STDIN_BYTES:
            raise ImageWorkerError("Input payload exceeds maximum size", http_status=413, error_code="payload_too_large")
        data = json.loads(raw.decode("utf-8"))
        if isinstance(data, dict) and data.get("stream_events") is True:
            stream_events = True
    except Exception as exc:
        err = _error_response_dict(exc)
        _emit_ndjson(err)
        sys.exit(1)

    def emit_delta(delta: str, model_slug: str) -> None:
        if stream_events and delta:
            ev: Dict[str, Any] = {"type": "delta", "delta": delta}
            if model_slug:
                ev["model"] = model_slug
            _emit_ndjson(ev)

    result = handle_text_payload(data, on_delta=emit_delta if stream_events else None)
    if stream_events:
        if result.get("ok"):
            _emit_ndjson(
                {
                    "ok": True,
                    "type": "done",
                    "text": result.get("text", ""),
                    "conversation_id": result.get("conversation_id", ""),
                    "model": result.get("model", ""),
                }
            )
            sys.exit(0)
        _emit_ndjson(result)
        sys.exit(1)

    _emit_ndjson(result)
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
