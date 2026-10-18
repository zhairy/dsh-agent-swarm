#!/usr/bin/env python3
"""Run a bounded, evidence-preserving Jev 1.14.0 MCP review.

This operational helper is not shipped in the plugin package. Example:
  python3 review-jev-release.py --command /path/to/jev-wrapper \
    --payload review-payload.json --out review-results.json

Payload contract (no credentials):
  {
    "state": {"scope": "...", "codeDigest": "...", "evidence": []},
    "tools": {
      "jev_ask": {"questions": {"claim": {"type": "noul", "instructions": "..."}}},
      "jev_check": {"propositions": {"claim": "..."}},
      "jev_classify": {"question": "...", "labels": {"supported": "...", "gap": "..."}},
      "jev_match": {"query": "Include the relevant evidence here", "candidates": {"a": "..."}},
      "jev_score": {"question": "...", "levels": ["Evidence absent", "Evidence sufficient"]},
      "jev_screen": {"source": "Release evidence"}
    }
  }

State is injected into ask/check/classify/score. Match has no state argument:
its explicit query/candidates must contain the evidence needed for that judgment.
Screen defaults to a prefixed textual serialization of state. Health verifies
connectivity only; a successful tool call never means a positive code verdict.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sys
import tempfile
import time
from datetime import datetime, timezone
from typing import Any


MODEL = "jev-1.14.0"
TOOL_ORDER = (
    "jev_health", "jev_ask", "jev_check", "jev_classify", "jev_match",
    "jev_score", "jev_screen", "jev_health",
)
STATE_TOOLS = {"jev_ask", "jev_check", "jev_classify", "jev_score"}
SAFE_ERROR_TYPE = re.compile(r"Jev tool failed \(([A-Za-z_][A-Za-z0-9_.]{0,100})\)")


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def reject_constant(value: str) -> None:
    raise ValueError(f"Non-finite JSON number is not permitted: {value}")


def read_payload(path: Path) -> tuple[dict[str, Any], str]:
    data = path.read_bytes()
    payload = json.loads(data, parse_constant=reject_constant)
    if not isinstance(payload, dict) or "state" not in payload:
        raise ValueError("Payload must be an object containing state")
    configured = payload.get("tools")
    if not isinstance(configured, dict):
        raise ValueError("Payload tools must contain explicit review questions")
    for name in TOOL_ORDER[1:-1]:
        if not isinstance(configured.get(name), dict):
            raise ValueError(f"Payload tools.{name} must be an object")
        if "state" in configured[name]:
            raise ValueError(f"Use the common top-level state, not tools.{name}.state")
    required = {
        "jev_ask": ("questions",), "jev_check": ("propositions",),
        "jev_classify": ("labels",), "jev_match": ("query", "candidates"),
        "jev_score": ("question", "levels"),
    }
    for name, fields in required.items():
        for field in fields:
            if not configured[name].get(field):
                raise ValueError(f"Payload tools.{name}.{field} is required and non-empty")
    return payload, hashlib.sha256(data).hexdigest()


def arguments_for(name: str, payload: dict[str, Any]) -> dict[str, Any]:
    if name == "jev_health":
        return {}
    arguments = dict(payload["tools"][name])
    if name in STATE_TOOLS:
        arguments["state"] = payload["state"]
    if name == "jev_screen":
        text = arguments.get("text", payload["state"])
        if not isinstance(text, str):
            text = json.dumps(text, ensure_ascii=False, allow_nan=False)
        # Some MCP bridges decode strings that are complete JSON documents.
        arguments["text"] = "审核材料（健康检查不代表代码正确性）：\n" + text
    return arguments


def persist(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=f".{path.name}.", delete=False) as output:
            temporary = output.name
            json.dump(report, output, ensure_ascii=False, indent=2, allow_nan=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)


def body_for(response: dict[str, Any]) -> dict[str, Any] | None:
    result = response.get("result")
    if not isinstance(result, dict):
        return None
    if isinstance(result.get("structuredContent"), dict):
        return result["structuredContent"]
    for item in result.get("content", []):
        if isinstance(item, dict) and item.get("type") == "text":
            try:
                body = json.loads(item.get("text", ""), parse_constant=reject_constant)
            except (TypeError, ValueError):
                continue
            if isinstance(body, dict):
                return body
    return None


async def collect_stderr(stream: asyncio.StreamReader, diagnostics: dict[str, Any]) -> None:
    # Never persist arbitrary wrapper output: it might contain credentials or state.
    while chunk := await stream.read(4096):
        diagnostics["stderrBytes"] += len(chunk)
        for match in SAFE_ERROR_TYPE.finditer(chunk.decode("utf-8", errors="replace")):
            diagnostics["safeExceptionTypes"].append(match.group(1))


async def exchange(process: asyncio.subprocess.Process, request: dict[str, Any],
                   deadline: float, diagnostics: dict[str, Any]) -> dict[str, Any]:
    assert process.stdin is not None and process.stdout is not None
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Overall review deadline reached")
    process.stdin.write((json.dumps(request, ensure_ascii=False, allow_nan=False) + "\n").encode())
    await asyncio.wait_for(process.stdin.drain(), remaining)
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("MCP request deadline reached")
        line = await asyncio.wait_for(process.stdout.readline(), remaining)
        if not line:
            raise RuntimeError("MCP process closed stdout before its response")
        response = json.loads(line, parse_constant=reject_constant)
        if not isinstance(response, dict):
            raise ValueError("MCP returned a non-object message")
        if response.get("id") == request["id"]:
            return response
        diagnostics["otherMessages"] += 1


async def stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    try:
        process.terminate()
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(process.wait(), 5)
    except TimeoutError:
        process.kill()
        await asyncio.wait_for(process.wait(), 5)


async def run_review(args: argparse.Namespace, payload: dict[str, Any], digest: str) -> int:
    report: dict[str, Any] = {
        "formatVersion": 1, "startedAt": timestamp(), "requestedModel": MODEL,
        "payloadSha256": digest, "purpose": "release-evidence-review",
        "interpretation": "Tool success is availability, not code correctness. Health supplies no code evidence.",
        "runs": [], "diagnostics": {"stderrBytes": 0, "safeExceptionTypes": [], "otherMessages": 0},
    }
    persist(args.out, report)
    deadline = time.monotonic() + args.overall_timeout
    process: asyncio.subprocess.Process | None = None
    stderr_task: asyncio.Task[None] | None = None
    try:
        command = shlex.split(args.command)
        if not command:
            raise ValueError("Command is empty")
        process = await asyncio.wait_for(asyncio.create_subprocess_exec(
            *command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, limit=16 * 1024 * 1024,
            env={**os.environ, "JEV_MCP_MODEL": MODEL}), min(args.tool_timeout, max(0.001, deadline - time.monotonic())))
        assert process.stderr is not None and process.stdin is not None
        stderr_task = asyncio.create_task(collect_stderr(process.stderr, report["diagnostics"]))
        initialize = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "clientInfo": {"name": "swarm-release-review", "version": "2.9.2"},
        }}
        report["initializeRequest"] = initialize
        persist(args.out, report)
        initialized = await exchange(process, initialize, min(deadline, time.monotonic() + args.tool_timeout), report["diagnostics"])
        report["initializeResponse"] = initialized
        if "error" in initialized or not isinstance(initialized.get("result"), dict):
            raise RuntimeError("MCP initialization failed")
        process.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        await asyncio.wait_for(process.stdin.drain(), min(args.tool_timeout, max(0.001, deadline - time.monotonic())))
        for index, name in enumerate(TOOL_ORDER, start=2):
            request = {"jsonrpc": "2.0", "id": index, "method": "tools/call",
                       "params": {"name": name, "arguments": arguments_for(name, payload)}}
            run: dict[str, Any] = {"tool": name, "startedAt": timestamp(), "request": request}
            report["runs"].append(run)
            persist(args.out, report)
            response = await exchange(process, request, min(deadline, time.monotonic() + args.tool_timeout), report["diagnostics"])
            body = body_for(response)
            run.update({"finishedAt": timestamp(), "response": response,
                        "toolOk": bool(body and body.get("ok") is True and not response.get("error")
                                       and not response.get("result", {}).get("isError")),
                        "modelMatches": bool(body and body.get("model") == MODEL)})
            persist(args.out, report)
            print(json.dumps({"tool": name, "toolOk": run["toolOk"], "modelMatches": run["modelMatches"]}), flush=True)
    except Exception as error:
        # Exception messages may include command output; preserve only the safe class.
        report["failure"] = {"type": type(error).__name__, "at": timestamp(),
                             "message": "Review transport failed; inspect saved requests and safe diagnostics."}
    finally:
        if process is not None:
            try:
                await stop_process(process)
            except (OSError, TimeoutError) as error:
                report["cleanupFailure"] = type(error).__name__
        if stderr_task is not None:
            stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)
        report["finishedAt"] = timestamp()
        report["allToolsReturnedOk"] = len(report["runs"]) == len(TOOL_ORDER) and all(
            item.get("toolOk") and item.get("modelMatches") for item in report["runs"])
        report["reviewVerdict"] = "not-computed; assess the recorded answers against the supplied evidence"
        persist(args.out, report)
    return 0 if report["allToolsReturnedOk"] and "failure" not in report and "cleanupFailure" not in report else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--command", required=True, help="MCP wrapper command, parsed without invoking a shell")
    parser.add_argument("--payload", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--tool-timeout", type=float, default=60)
    parser.add_argument("--overall-timeout", type=float, default=600)
    args = parser.parse_args()
    if not 0 < args.tool_timeout <= 60 or not 0 < args.overall_timeout <= 600:
        parser.error("tool-timeout must be in (0, 60], overall-timeout in (0, 600]")
    if args.payload.resolve() == args.out.resolve():
        parser.error("--out must not overwrite the payload")
    if args.out.exists():
        parser.error("--out already exists; choose a new evidence file")
    try:
        payload, digest = read_payload(args.payload)
        return asyncio.run(run_review(args, payload, digest))
    except (OSError, ValueError) as error:
        print(f"Review setup/output failed ({type(error).__name__}); verify payload shape and file access.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
